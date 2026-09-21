from __future__ import annotations

import importlib.util
import json
import os
import jsonschema
from pathlib import Path
import tempfile
import unittest
from unittest import mock

MODULE_PATH = Path(__file__).parents[1] / "deploy_skill_set.py"
SPEC = importlib.util.spec_from_file_location("deploy_skill_set", MODULE_PATH)
assert SPEC and SPEC.loader
cutover = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cutover)


class DeploymentToolTests(unittest.TestCase):
    def make_tree(self, root: Path, values: dict[str, str | None]) -> None:
        for relative, value in values.items():
            path = root / relative
            if value is None:
                path.mkdir(parents=True, exist_ok=True)
            elif value.startswith("->"):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.symlink_to(value[2:])
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(value, encoding="utf-8")

    def assert_manifest(self, root: Path, manifest: dict) -> None:
        stat = root.stat()
        cutover.verify_manifest(root, manifest, stat.st_uid, stat.st_gid)

    def test_manifest_tracks_empty_directories_symlinks_modes_and_absences(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "skills"
            root.mkdir()
            self.make_tree(
                root,
                {
                    "code-review/SKILL.md": "review\n",
                    "code-review/empty": None,
                    "code-review/link": "->SKILL.md",
                },
            )
            os.chmod(root / "code-review", 0o750)
            identities = ["code-review", "security-audit"]
            stat = root.stat()

            manifest = cutover.scan_manifest(root, identities, stat.st_uid, stat.st_gid)

            self.assertEqual(manifest["owner_policy"], "target-root")
            self.assertEqual(manifest["absent_identities"], ["security-audit"])
            entries = {entry["path"]: entry for entry in manifest["entries"]}
            self.assertEqual(entries["code-review"]["mode"], "0750")
            self.assertEqual(entries["code-review/empty"]["type"], "directory")
            self.assertEqual(entries["code-review/link"]["type"], "symlink")
            self.assertEqual(entries["code-review/link"]["target"], "SKILL.md")
            self.assert_manifest(root, manifest)

    def test_manifest_rejects_owned_entry_outside_target_root_ownership(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "skills"
            root.mkdir()
            self.make_tree(root, {"code-review/SKILL.md": "review\n"})
            stat = root.stat()

            with self.assertRaisesRegex(cutover.CutoverError, "ownership"):
                cutover.scan_manifest(root, ["code-review"], stat.st_uid + 1, stat.st_gid)

    def test_capability_probe_uses_nofollow_symlink_ownership_and_cleans_scratch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "skills"
            target.mkdir()
            state = Path(tmp) / "state"

            evidence = cutover.capability_probe(target, state)

            self.assertEqual(evidence["status"], "passed")
            self.assertTrue(evidence["referent_unchanged"])
            self.assertIn("follow_symlinks=False", evidence["symlink_primitive"])
            self.assertEqual(list(state.glob("probe-*")), [])

    def test_journal_rejects_tampered_hash_chain(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            journal = cutover.Journal(Path(tmp) / "records", {"transaction_id": "member-1", "operation": "cutover-v1", "member_id": "member-1"}, "member")
            journal.append("initializing", {})
            second = journal.append("prepared", {})
            record_path = journal.path / f"{second['sequence']:08d}.json"
            payload = json.loads(record_path.read_text(encoding="utf-8"))
            payload["phase"] = "committed"
            record_path.write_text(json.dumps(payload), encoding="utf-8")

            with self.assertRaisesRegex(cutover.CutoverError, "digest"):
                journal.read_all()

    def test_cutover_crash_before_set_commit_restores_every_member_to_baseline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            source = base / "source"
            source.mkdir()
            self.make_tree(source, {"code-review/SKILL.md": "new\n", "security-audit/SKILL.md": "audit\n"})
            targets = [base / "target-a", base / "target-b"]
            for target in targets:
                target.mkdir()
                self.make_tree(target, {"code-review/SKILL.md": "old\n", "fix-code-review/SKILL.md": "fix\n"})
            identities = ["code-review", "fix-code-review", "security-audit"]
            uid, gid = targets[0].stat().st_uid, targets[0].stat().st_gid
            expected = cutover.scan_manifest(targets[0], identities, uid, gid)
            desired = cutover.scan_manifest(source, identities, source.stat().st_uid, source.stat().st_gid)
            coordinator = cutover.DeploymentCoordinator(base / "state")

            with self.assertRaises(cutover.InjectedCrash) as raised:
                coordinator.start_set(
                    "cutover-v1",
                    source,
                    targets,
                    identities,
                    expected,
                    desired,
                    failpoint="after-member-committed:0",
                )

            result = coordinator.resume_set(raised.exception.set_id)
            self.assertEqual(result["phase"], "set-recovered")
            for target in targets:
                self.assert_manifest(target, expected)
                self.assertEqual((target / "code-review/SKILL.md").read_text(), "old\n")
                self.assertFalse((target / "security-audit").exists())

    def test_rollback_crash_converges_unfinished_members_forward_to_baseline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            baseline = base / "baseline"
            baseline.mkdir()
            self.make_tree(baseline, {"code-review/SKILL.md": "old\n", "fix-code-review/SKILL.md": "fix\n"})
            targets = [base / "target-a", base / "target-b"]
            for target in targets:
                target.mkdir()
                self.make_tree(target, {"code-review/SKILL.md": "new\n", "security-audit/SKILL.md": "audit\n"})
            identities = ["code-review", "fix-code-review", "security-audit"]
            uid, gid = targets[0].stat().st_uid, targets[0].stat().st_gid
            expected = cutover.scan_manifest(targets[0], identities, uid, gid)
            desired = cutover.scan_manifest(baseline, identities, baseline.stat().st_uid, baseline.stat().st_gid)
            coordinator = cutover.DeploymentCoordinator(base / "state")
            deployed = base / "deployed"
            deployed.mkdir()
            self.make_tree(deployed, {"code-review/SKILL.md": "new\n", "security-audit/SKILL.md": "audit\n"})
            deployed_manifest = cutover.scan_manifest(deployed, identities, deployed.stat().st_uid, deployed.stat().st_gid)
            parent = coordinator.start_set("cutover-v1", deployed, targets, identities, expected, deployed_manifest)
            child_id = coordinator.record_validation_failure(parent["set_id"], baseline, targets, identities, desired)

            with self.assertRaises(cutover.InjectedCrash) as raised:
                coordinator.start_set(
                    "baseline-v1",
                    baseline,
                    targets,
                    identities,
                    deployed_manifest,
                    desired,
                    parent_set_id=parent["set_id"],
                    failpoint="after-member-committed:0",
                )
            self.assertEqual(raised.exception.set_id, child_id)

            result = coordinator.resume_set(raised.exception.set_id)
            self.assertEqual(result["phase"], "set-committed")
            for target in targets:
                self.assert_manifest(target, desired)
                self.assertEqual((target / "code-review/SKILL.md").read_text(), "old\n")
                self.assertTrue((target / "fix-code-review/SKILL.md").exists())
                self.assertFalse((target / "security-audit").exists())

    def test_unbound_prejournal_set_directory_blocks_new_admission(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state"
            debris = state / "sets" / ("ds-" + "0" * 64)
            debris.mkdir(parents=True)
            coordinator = cutover.DeploymentCoordinator(state)

            with self.assertRaisesRegex(cutover.CutoverError, "pre-journal"):
                coordinator.assert_admission_clear(None)


    def test_member_initializing_record_survives_prepare(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            source, target = base / "source", base / "target"
            source.mkdir(); target.mkdir()
            self.make_tree(source, {"code-review/SKILL.md": "new\n"})
            self.make_tree(target, {"code-review/SKILL.md": "old\n"})
            identities = ["code-review"]
            uid, gid = target.stat().st_uid, target.stat().st_gid
            expected = cutover.scan_manifest(target, identities, uid, gid)
            desired = cutover.scan_manifest(source, identities, source.stat().st_uid, source.stat().st_gid)
            coordinator = cutover.DeploymentCoordinator(base / "state")
            with self.assertRaises(cutover.InjectedCrash) as raised:
                coordinator.start_set("cutover-v1", source, [target], identities, expected, desired, failpoint="after-member-prepared:0")
            intent = coordinator._intent(raised.exception.set_id)
            journal = cutover.Journal(Path(intent["members"][0]["workspace"]) / "records", cutover.member_binding(intent, intent["members"][0]), "member")
            self.assertEqual([record["phase"] for record in journal.read_all()], ["initializing", "prepared"])

    def test_matching_prejournal_set_resumes_after_proving_no_effect(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            source, target = base / "source", base / "target"
            source.mkdir(); target.mkdir()
            self.make_tree(source, {"code-review/SKILL.md": "new\n"})
            self.make_tree(target, {"code-review/SKILL.md": "old\n"})
            identities = ["code-review"]
            uid, gid = target.stat().st_uid, target.stat().st_gid
            expected = cutover.scan_manifest(target, identities, uid, gid)
            desired = cutover.scan_manifest(source, identities, source.stat().st_uid, source.stat().st_gid)
            coordinator = cutover.DeploymentCoordinator(base / "state")
            with self.assertRaises(cutover.InjectedCrash) as raised:
                coordinator.start_set("cutover-v1", source, [target], identities, expected, desired, failpoint="after-set-directory-before-first-record")
            result = coordinator.resume_set(raised.exception.set_id)
            self.assertEqual(result["phase"], "set-committed")
            self.assert_manifest(target, desired)

    def test_alias_targets_are_deduplicated_into_one_member(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            source, target, alias = base / "source", base / "target", base / "alias"
            source.mkdir(); target.mkdir(); alias.symlink_to(target, target_is_directory=True)
            self.make_tree(source, {"code-review/SKILL.md": "new\n"})
            self.make_tree(target, {"code-review/SKILL.md": "old\n"})
            identities = ["code-review"]
            uid, gid = target.stat().st_uid, target.stat().st_gid
            expected = cutover.scan_manifest(target, identities, uid, gid)
            desired = cutover.scan_manifest(source, identities, source.stat().st_uid, source.stat().st_gid)
            coordinator = cutover.DeploymentCoordinator(base / "state")
            result = coordinator.start_set("cutover-v1", source, [target, alias], identities, expected, desired)
            intent = coordinator._intent(result["set_id"])
            self.assertEqual(len(intent["members"]), 1)
            self.assertEqual(set(intent["members"][0]["aliases"]), {str(target), str(alias)})
            self.assert_manifest(target, desired)

    def test_baseline_resume_records_recovering_and_restages_consumed_stage(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            baseline, cutover_source, target = base / "baseline", base / "cutover", base / "target"
            baseline.mkdir(); cutover_source.mkdir(); target.mkdir()
            self.make_tree(baseline, {"code-review/SKILL.md": "old\n"})
            self.make_tree(cutover_source, {"code-review/SKILL.md": "new\n"})
            self.make_tree(target, {"code-review/SKILL.md": "new\n"})
            identities = ["code-review"]
            uid, gid = target.stat().st_uid, target.stat().st_gid
            cutover_manifest = cutover.scan_manifest(target, identities, uid, gid)
            baseline_manifest = cutover.scan_manifest(baseline, identities, baseline.stat().st_uid, baseline.stat().st_gid)
            coordinator = cutover.DeploymentCoordinator(base / "state")
            parent = coordinator.start_set("cutover-v1", cutover_source, [target], identities, cutover_manifest, cutover_manifest)
            child_id = coordinator.record_validation_failure(parent["set_id"], baseline, [target], identities, baseline_manifest)
            with self.assertRaises(cutover.InjectedCrash):
                coordinator.start_set("baseline-v1", baseline, [target], identities, cutover_manifest, baseline_manifest, parent_set_id=parent["set_id"], failpoint="after-member-replaced:0")
            result = coordinator.resume_set(child_id)
            self.assertEqual(result["phase"], "set-committed")
            intent = coordinator._intent(child_id)
            journal = cutover.Journal(Path(intent["members"][0]["workspace"]) / "records", cutover.member_binding(intent, intent["members"][0]), "member")
            phases = [record["phase"] for record in journal.read_all()]
            self.assertIn("recovering", phases)
            self.assertEqual(phases[-1], "committed")
            self.assert_manifest(target, baseline_manifest)

    def test_baseline_child_requires_receipt_bound_parent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            source, target = base / "source", base / "target"
            source.mkdir(); target.mkdir()
            self.make_tree(source, {"code-review/SKILL.md": "old\n"})
            self.make_tree(target, {"code-review/SKILL.md": "new\n"})
            identities = ["code-review"]
            uid, gid = target.stat().st_uid, target.stat().st_gid
            expected = cutover.scan_manifest(target, identities, uid, gid)
            desired = cutover.scan_manifest(source, identities, source.stat().st_uid, source.stat().st_gid)
            coordinator = cutover.DeploymentCoordinator(base / "state")
            with self.assertRaisesRegex(cutover.CutoverError, "receipt-bound parent"):
                coordinator.start_set("baseline-v1", source, [target], identities, expected, desired)

    def test_journal_rejects_unexpected_gap_duplicate_malformed_and_phase_mismatch(self) -> None:
        binding = {"transaction_id": "tx-1", "operation": "cutover-v1"}
        for case in ("unexpected", "gap", "duplicate", "malformed", "phase", "binding"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as tmp:
                journal = cutover.Journal(Path(tmp) / "records", binding, "set")
                journal.append("set-initializing", {})
                journal.append("set-prepared", {})
                if case == "unexpected":
                    (journal.path / "trailing.tmp").write_text("x")
                elif case == "gap":
                    (journal.path / "00000002.json").rename(journal.path / "00000003.json")
                elif case == "duplicate":
                    payload = json.loads((journal.path / "00000002.json").read_text())
                    payload["sequence"] = 1
                    unsigned = dict(payload); unsigned.pop("record_sha256")
                    payload["record_sha256"] = cutover.sha256_bytes(cutover.canonical_bytes(unsigned))
                    (journal.path / "00000002.json").write_text(json.dumps(payload))
                elif case == "malformed":
                    (journal.path / "00000003.json").write_text("{")
                elif case == "phase":
                    with self.assertRaisesRegex(cutover.CutoverError, "phase transition"):
                        journal.append("set-committed", {})
                    continue
                else:
                    payload = json.loads((journal.path / "00000002.json").read_text())
                    payload["binding"]["operation"] = "baseline-v1"
                    unsigned = dict(payload); unsigned.pop("record_sha256")
                    payload["record_sha256"] = cutover.sha256_bytes(cutover.canonical_bytes(unsigned))
                    (journal.path / "00000002.json").write_text(json.dumps(payload))
                with self.assertRaises(cutover.CutoverError):
                    journal.read_all()


    def test_baseline_import_is_content_addressed_and_reproducible(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            source = base / "skills"
            source.mkdir()
            self.make_tree(source, {"code-review/SKILL.md": "old\n", "file-mr/SKILL.md": "file\n"})
            output = base / "baselines"
            identities = ["code-review", "file-mr"]

            preflight = cutover.preflight_targets([source], identities, base / "preflight-state")
            receipt = base / "private-import-receipt.json"
            first = cutover.import_baseline(source, output, identities, "abc123", preflight, receipt)
            second = cutover.import_baseline(source, output, identities, "abc123", preflight, receipt)

            self.assertEqual(first["owned_tree_sha256"], second["owned_tree_sha256"])
            imported = output / first["owned_tree_sha256"] / "skills"
            self.assertEqual((imported / "code-review/SKILL.md").read_text(), "old\n")
            portable = json.loads((output / first["owned_tree_sha256"] / "baseline-source.json").read_text())
            self.assertEqual(portable["fork_revision"], "abc123")
            self.assertNotIn("source_root", portable)
            self.assertNotIn("preflight_sha256", portable)
            self.assertEqual(json.loads(receipt.read_text())["preflight_sha256"], preflight["preflight_sha256"])

    def test_completed_rollback_child_closes_parent_chain_for_new_admission(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            before = base / "before"
            after = base / "after"
            before.mkdir()
            after.mkdir()
            self.make_tree(before, {"code-review/SKILL.md": "old\n"})
            self.make_tree(after, {"code-review/SKILL.md": "new\n"})
            target = base / "target"
            target.mkdir()
            self.make_tree(target, {"code-review/SKILL.md": "old\n"})
            identities = ["code-review"]
            expected = cutover.scan_manifest(before, identities, before.stat().st_uid, before.stat().st_gid)
            desired = cutover.scan_manifest(after, identities, after.stat().st_uid, after.stat().st_gid)
            coordinator = cutover.DeploymentCoordinator(base / "state")
            parent = coordinator.start_set("cutover-v1", after, [target], identities, expected, desired)
            child_id = coordinator.record_validation_failure(parent["set_id"], before, [target], identities, expected)
            child = coordinator.start_set("baseline-v1", before, [target], identities, desired, expected, parent_set_id=parent["set_id"])
            self.assertEqual(child["set_id"], child_id)
            coordinator.validate_set(child_id)
            coordinator.cleanup_set(child_id)

            coordinator.assert_admission_clear(None)


    def test_preflight_deduplicates_aliases_and_binds_private_sentinel(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            target = base / "skills"
            target.mkdir()
            self.make_tree(target, {"code-review/SKILL.md": "old\n", "unrelated/SKILL.md": "keep\n"})
            alias = base / "alias"
            alias.symlink_to(target, target_is_directory=True)
            identities = ["security-audit", "code-review", "fix-code-review", "fix-code-audit", "quality-checklist", "file-mr"]

            evidence = cutover.preflight_targets([target, alias], identities, base / "state")

            self.assertEqual(len(evidence["members"]), 1)
            self.assertEqual(set(evidence["members"][0]["aliases"]), {str(target), str(alias)})
            self.assertTrue(evidence["members"][0]["sentinel_sha256"])
            self.assertTrue(evidence["members"][0]["sentinel"])

    def test_preflight_rejects_missing_supplementary_group(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "skills"
            target.mkdir()
            self.make_tree(target, {"code-review/SKILL.md": "old\n"})
            with mock.patch.object(cutover.os, "getegid", return_value=target.stat().st_gid + 1000), mock.patch.object(cutover.os, "getgroups", return_value=[]):
                with self.assertRaisesRegex(cutover.CutoverError, "supplementary groups"):
                    cutover.preflight_targets([target], ["code-review"], Path(tmp) / "state")

    def test_capability_probe_blocks_ownership_and_nofollow_failures(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "skills"
            target.mkdir()
            cases = (
                ("authority", "fchown", PermissionError("denied")),
                ("nofollow", "chown", NotImplementedError("unsupported")),
                ("mode-clearing", "fchmod", None),
            )
            for label, function, effect in cases:
                with self.subTest(label=label):
                    patcher = mock.patch.object(cutover.os, function, side_effect=effect) if effect is not None else mock.patch.object(cutover.os, function, return_value=None)
                    with patcher, self.assertRaises(cutover.CutoverError):
                        cutover.capability_probe(target, Path(tmp) / f"state-{label}")

    def test_cleanup_failure_keeps_validated_set_lifecycle_active(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            source = base / "source"
            target = base / "target"
            source.mkdir(); target.mkdir()
            self.make_tree(source, {"code-review/SKILL.md": "new\n"})
            self.make_tree(target, {"code-review/SKILL.md": "old\n"})
            identities = ["code-review"]
            expected = cutover.scan_manifest(target, identities, target.stat().st_uid, target.stat().st_gid)
            desired = cutover.scan_manifest(source, identities, source.stat().st_uid, source.stat().st_gid)
            coordinator = cutover.DeploymentCoordinator(base / "state")
            result = coordinator.start_set("cutover-v1", source, [target], identities, expected, desired)
            coordinator.validate_set(result["set_id"])

            with mock.patch.object(cutover.shutil, "rmtree", side_effect=OSError("cleanup failed")):
                with self.assertRaisesRegex(cutover.CutoverError, "cleanup failed"):
                    coordinator.cleanup_set(result["set_id"])
            intent = coordinator._intent(result["set_id"])
            failure = coordinator._set_journal(intent).read_all()[-1]
            self.assertEqual(failure["phase"], "cleanup-failed")
            schema = json.loads((MODULE_PATH.parent / "manifests/cleanup-receipt.schema.json").read_text())
            jsonschema.validate(failure["data"], schema)
            with self.assertRaisesRegex(cutover.CutoverError, "lifecycle-active"):
                coordinator.assert_admission_clear(None)
            self.assertEqual(coordinator.cleanup_set(result["set_id"])["phase"], "cleanup-complete")
            coordinator.assert_admission_clear(None)

    def test_committed_resume_rejects_owned_and_inode_drift(self) -> None:
        for drift in ("content", "inode"):
            with self.subTest(drift=drift), tempfile.TemporaryDirectory() as tmp:
                base = Path(tmp)
                source = base / "source"
                target = base / "target"
                source.mkdir(); target.mkdir()
                self.make_tree(source, {"code-review/SKILL.md": "new\n"})
                self.make_tree(target, {"code-review/SKILL.md": "old\n"})
                identities = ["code-review"]
                expected = cutover.scan_manifest(target, identities, target.stat().st_uid, target.stat().st_gid)
                desired = cutover.scan_manifest(source, identities, source.stat().st_uid, source.stat().st_gid)
                coordinator = cutover.DeploymentCoordinator(base / "state")
                result = coordinator.start_set("cutover-v1", source, [target], identities, expected, desired)
                if drift == "content":
                    (target / "code-review/SKILL.md").write_text("drift\n")
                else:
                    replacement = base / "replacement"
                    replacement.mkdir()
                    self.make_tree(replacement, {"code-review/SKILL.md": "new\n"})
                    old = base / "old-target"
                    target.rename(old)
                    replacement.rename(target)
                with self.assertRaises(cutover.CutoverError):
                    coordinator.resume_set(result["set_id"])

    def test_invalid_initializing_member_beneath_prepared_set_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            source = base / "source"
            target = base / "target"
            source.mkdir(); target.mkdir()
            self.make_tree(source, {"code-review/SKILL.md": "new\n"})
            self.make_tree(target, {"code-review/SKILL.md": "old\n"})
            identities = ["code-review"]
            expected = cutover.scan_manifest(target, identities, target.stat().st_uid, target.stat().st_gid)
            desired = cutover.scan_manifest(source, identities, source.stat().st_uid, source.stat().st_gid)
            coordinator = cutover.DeploymentCoordinator(base / "state")
            with self.assertRaises(cutover.InjectedCrash) as raised:
                coordinator.start_set("cutover-v1", source, [target], identities, expected, desired, failpoint="after-member-prepared:0")
            intent = coordinator._intent(raised.exception.set_id)
            member_records = Path(intent["members"][0]["workspace"]) / "records"
            (member_records / "00000002.json").unlink()
            coordinator._set_journal(intent).append("set-prepared", {"member_count": 1})

            with self.assertRaisesRegex(cutover.CutoverError, "invalid chain"):
                coordinator.resume_set(raised.exception.set_id)
            coordinator._set_journal(intent).append("set-applying", {"member_count": 1})
            with self.assertRaisesRegex(cutover.CutoverError, "invalid chain"):
                coordinator.resume_set(raised.exception.set_id)

    def test_cutover_recovers_every_uncommitted_publication_boundary(self) -> None:
        for failpoint in ("after-set-prepared", "after-set-applying", "after-member-applying:0"):
            with self.subTest(failpoint=failpoint), tempfile.TemporaryDirectory() as tmp:
                base = Path(tmp)
                source = base / "source"
                target = base / "target"
                source.mkdir(); target.mkdir()
                self.make_tree(source, {"code-review/SKILL.md": "new\n"})
                self.make_tree(target, {"code-review/SKILL.md": "old\n"})
                identities = ["code-review"]
                expected = cutover.scan_manifest(target, identities, target.stat().st_uid, target.stat().st_gid)
                desired = cutover.scan_manifest(source, identities, source.stat().st_uid, source.stat().st_gid)
                coordinator = cutover.DeploymentCoordinator(base / "state")
                with self.assertRaises(cutover.InjectedCrash) as raised:
                    coordinator.start_set("cutover-v1", source, [target], identities, expected, desired, failpoint=failpoint)
                self.assertEqual(coordinator.resume_set(raised.exception.set_id)["phase"], "set-recovered")
                self.assert_manifest(target, expected)

    def test_member_engine_requires_exact_set_journal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            source = base / "source"
            target = base / "target"
            source.mkdir(); target.mkdir()
            self.make_tree(source, {"code-review/SKILL.md": "new\n"})
            self.make_tree(target, {"code-review/SKILL.md": "old\n"})
            identities = ["code-review"]
            expected = cutover.scan_manifest(target, identities, target.stat().st_uid, target.stat().st_gid)
            desired = cutover.scan_manifest(source, identities, source.stat().st_uid, source.stat().st_gid)
            coordinator = cutover.DeploymentCoordinator(base / "state")
            result = coordinator.start_set("cutover-v1", source, [target], identities, expected, desired)
            wrong = base / "wrong-journal"
            wrong.mkdir()
            with self.assertRaisesRegex(cutover.CutoverError, "exact set journal"):
                coordinator.run_member_mode("check", result["set_id"], source, target, desired, expected, wrong)
            exact = base / "state" / "sets" / result["set_id"] / "records"
            with mock.patch.object(cutover, "capability_probe", side_effect=AssertionError("check must not probe")):
                checked = coordinator.run_member_mode("check", result["set_id"], source, target, desired, expected, exact)
            self.assertEqual(checked["member_phase"], "committed")

    def test_intent_tamper_is_rejected_before_resume(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            source = base / "source"
            target = base / "target"
            source.mkdir(); target.mkdir()
            self.make_tree(source, {"code-review/SKILL.md": "new\n"})
            self.make_tree(target, {"code-review/SKILL.md": "old\n"})
            identities = ["code-review"]
            expected = cutover.scan_manifest(target, identities, target.stat().st_uid, target.stat().st_gid)
            desired = cutover.scan_manifest(source, identities, source.stat().st_uid, source.stat().st_gid)
            coordinator = cutover.DeploymentCoordinator(base / "state")
            result = coordinator.start_set("cutover-v1", source, [target], identities, expected, desired)
            path = base / "state" / "sets" / result["set_id"] / "intent.json"
            intent = json.loads(path.read_text())
            intent["members"][0]["sentinel"] = {"tampered": True}
            path.write_text(json.dumps(intent))
            with self.assertRaisesRegex(cutover.CutoverError, "binding mismatch"):
                coordinator.resume_set(result["set_id"])


    def test_manifest_scan_rejects_owned_xattrs_and_wrong_ownership(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "skills"
            target.mkdir()
            self.make_tree(target, {"code-review/SKILL.md": "old\n"})
            real_listxattr = cutover.os.listxattr

            def injected_xattrs(path, *, follow_symlinks=False):
                if str(path).endswith("SKILL.md"):
                    return ["user.test"]
                return real_listxattr(path, follow_symlinks=follow_symlinks)

            with mock.patch.object(cutover.os, "listxattr", side_effect=injected_xattrs):
                with self.assertRaisesRegex(cutover.CutoverError, "xattr"):
                    cutover.scan_manifest(target, ["code-review"], target.stat().st_uid, target.stat().st_gid)
            with self.assertRaisesRegex(cutover.CutoverError, "ownership mismatch"):
                cutover.scan_manifest(target, ["code-review"], target.stat().st_uid + 1, target.stat().st_gid)


    def test_versioned_schemas_parse_and_validate_lifecycle_artifacts(self) -> None:
        schema_root = MODULE_PATH.parent / "manifests"
        schemas = {path.name: json.loads(path.read_text()) for path in schema_root.glob("*.schema.json")}
        for name, schema in schemas.items():
            with self.subTest(schema=name):
                jsonschema.Draft202012Validator.check_schema(schema)
        baselines = list((MODULE_PATH.parent / "baselines").glob("*/baseline-source.json"))
        self.assertEqual(len(baselines), 1)
        jsonschema.validate(json.loads(baselines[0].read_text()), schemas["baseline-source.schema.json"])

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            source = base / "source"
            target = base / "target"
            source.mkdir(); target.mkdir()
            self.make_tree(source, {"code-review/SKILL.md": "new\n"})
            self.make_tree(target, {"code-review/SKILL.md": "old\n"})
            identities = ["code-review"]
            expected = cutover.scan_manifest(target, identities, target.stat().st_uid, target.stat().st_gid)
            desired = cutover.scan_manifest(source, identities, source.stat().st_uid, source.stat().st_gid)
            coordinator = cutover.DeploymentCoordinator(base / "state")
            result = coordinator.start_set("cutover-v1", source, [target], identities, expected, desired)
            coordinator.validate_set(result["set_id"])
            coordinator.cleanup_set(result["set_id"])
            intent = coordinator._intent(result["set_id"])
            intent_schema = json.loads(json.dumps(schemas["cutover-intent.schema.json"]))
            intent_schema["properties"]["members"]["items"] = schemas["member-evidence.schema.json"]
            jsonschema.validate(intent, intent_schema)
            records = coordinator._set_journal(intent).read_all()
            for record in records:
                jsonschema.validate(record, schemas["journal-record.schema.json"])
            jsonschema.validate(records[-2]["data"], schemas["validation-receipt.schema.json"])
            jsonschema.validate(records[-1]["data"], schemas["cleanup-receipt.schema.json"])


    def test_materializer_reconstructs_git_lost_empty_directories_modes_and_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            source = base / "source"
            source.mkdir()
            self.make_tree(source, {"code-review/SKILL.md": "old\n", "code-review/empty": None, "code-review/link": "->SKILL.md"})
            os.chmod(source / "code-review", 0o750)
            os.chmod(source / "code-review/empty", 0o710)
            identities = ["code-review"]
            manifest = cutover.scan_manifest(source, identities, source.stat().st_uid, source.stat().st_gid)
            (source / "code-review/empty").rmdir()
            destination = base / "materialized"

            observed = cutover.materialize_manifest(source, destination, manifest, source.stat().st_uid, source.stat().st_gid)

            self.assertEqual(observed, manifest)
            self.assertTrue((destination / "code-review/empty").is_dir())
            self.assertEqual((destination / "code-review/empty").stat().st_mode & 0o777, 0o710)
            self.assertEqual(os.readlink(destination / "code-review/link"), "SKILL.md")

    def test_preflight_converges_two_distinct_targets(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            targets = [base / "target-a", base / "target-b"]
            for target in targets:
                target.mkdir()
                self.make_tree(target, {"code-review/SKILL.md": "old\n", "unrelated/SKILL.md": "keep\n"})
            evidence = cutover.preflight_targets(targets, ["code-review"], base / "state")
            self.assertEqual(len(evidence["members"]), 2)
            self.assertEqual({member["manifest_digest"] for member in evidence["members"]}, {evidence["owned_tree_sha256"]})
            self.assertEqual(len({(member["device"], member["inode"]) for member in evidence["members"]}), 2)

    def test_capability_probe_requires_same_filesystem_scratch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            target = base / "skills"
            state = base / "state"
            target.mkdir(); state.mkdir()
            real_stat = cutover.os.stat

            def changed_device(path, *args, **kwargs):
                result = real_stat(path, *args, **kwargs)
                if Path(path) == state:
                    values = list(result)
                    values[2] = result.st_dev + 1
                    return os.stat_result(values)
                return result

            with mock.patch.object(cutover.os, "stat", side_effect=changed_device):
                with self.assertRaisesRegex(cutover.CutoverError, "target filesystem"):
                    cutover.capability_probe(target, state)

    def test_unrelated_sibling_drift_blocks_scoped_recovery(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            source = base / "source"
            target = base / "target"
            source.mkdir(); target.mkdir()
            self.make_tree(source, {"code-review/SKILL.md": "new\n"})
            self.make_tree(target, {"code-review/SKILL.md": "old\n", "unrelated/SKILL.md": "keep\n"})
            identities = ["code-review"]
            expected = cutover.scan_manifest(target, identities, target.stat().st_uid, target.stat().st_gid)
            desired = cutover.scan_manifest(source, identities, source.stat().st_uid, source.stat().st_gid)
            coordinator = cutover.DeploymentCoordinator(base / "state")
            with self.assertRaises(cutover.InjectedCrash) as raised:
                coordinator.start_set("cutover-v1", source, [target], identities, expected, desired, failpoint="after-set-applying")
            (target / "unrelated/SKILL.md").write_text("drift\n")

            with self.assertRaisesRegex(cutover.CutoverError, "unrelated sibling drift"):
                coordinator.resume_set(raised.exception.set_id)


    def test_prepared_set_rejects_applying_or_committed_member(self) -> None:
        for member_phase in ("applying", "committed"):
            with self.subTest(member_phase=member_phase), tempfile.TemporaryDirectory() as tmp:
                base = Path(tmp)
                source = base / "source"
                target = base / "target"
                source.mkdir(); target.mkdir()
                self.make_tree(source, {"code-review/SKILL.md": "new\n"})
                self.make_tree(target, {"code-review/SKILL.md": "old\n"})
                identities = ["code-review"]
                expected = cutover.scan_manifest(target, identities, target.stat().st_uid, target.stat().st_gid)
                desired = cutover.scan_manifest(source, identities, source.stat().st_uid, source.stat().st_gid)
                coordinator = cutover.DeploymentCoordinator(base / "state")
                with self.assertRaises(cutover.InjectedCrash) as raised:
                    coordinator.start_set("cutover-v1", source, [target], identities, expected, desired, failpoint="after-set-prepared")
                intent = coordinator._intent(raised.exception.set_id)
                member_journal = coordinator._member_journal(intent, intent["members"][0])
                member_journal.append("applying", {})
                if member_phase == "committed":
                    member_journal.append("committed", {})
                with self.assertRaisesRegex(cutover.CutoverError, "invalid chain"):
                    coordinator.resume_set(raised.exception.set_id)

    def test_terminal_sets_reject_nonterminal_member_journals(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            source = base / "source"
            target = base / "target"
            source.mkdir(); target.mkdir()
            self.make_tree(source, {"code-review/SKILL.md": "new\n"})
            self.make_tree(target, {"code-review/SKILL.md": "old\n"})
            identities = ["code-review"]
            expected = cutover.scan_manifest(target, identities, target.stat().st_uid, target.stat().st_gid)
            desired = cutover.scan_manifest(source, identities, source.stat().st_uid, source.stat().st_gid)
            coordinator = cutover.DeploymentCoordinator(base / "state")
            committed = coordinator.start_set("cutover-v1", source, [target], identities, expected, desired)
            intent = coordinator._intent(committed["set_id"])
            records = Path(intent["members"][0]["workspace"]) / "records"
            (records / "00000004.json").unlink()
            with self.assertRaisesRegex(cutover.CutoverError, "invalid chain"):
                coordinator.resume_set(committed["set_id"])

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            source = base / "source"
            target = base / "target"
            source.mkdir(); target.mkdir()
            self.make_tree(source, {"code-review/SKILL.md": "new\n"})
            self.make_tree(target, {"code-review/SKILL.md": "old\n"})
            identities = ["code-review"]
            expected = cutover.scan_manifest(target, identities, target.stat().st_uid, target.stat().st_gid)
            desired = cutover.scan_manifest(source, identities, source.stat().st_uid, source.stat().st_gid)
            coordinator = cutover.DeploymentCoordinator(base / "state")
            with self.assertRaises(cutover.InjectedCrash) as raised:
                coordinator.start_set("cutover-v1", source, [target], identities, expected, desired, failpoint="after-member-committed:0")
            coordinator.resume_set(raised.exception.set_id)
            intent = coordinator._intent(raised.exception.set_id)
            records = Path(intent["members"][0]["workspace"]) / "records"
            (records / "00000006.json").unlink()
            with self.assertRaisesRegex(cutover.CutoverError, "invalid chain"):
                coordinator.resume_set(raised.exception.set_id)


if __name__ == "__main__":
    unittest.main()
