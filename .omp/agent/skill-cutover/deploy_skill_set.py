#!/usr/bin/env python3
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import time
from typing import Any, Iterable

SCHEMA_VERSION = 1
CLOSED_IDENTITIES = (
    "security-audit",
    "code-review",
    "fix-code-review",
    "fix-code-audit",
    "quality-checklist",
    "file-mr",
)
SET_TERMINAL_PHASES = {"set-recovered", "set-committed"}


class CutoverError(RuntimeError):
    pass


class InjectedCrash(RuntimeError):
    def __init__(self, set_id: str, failpoint: str):
        super().__init__(f"injected crash at {failpoint} for {set_id}")
        self.set_id = set_id
        self.failpoint = failpoint


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_json(path: Path, payload: Any, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(canonical_bytes(payload) + b"\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_path, mode)
        os.replace(temporary_path, path)
        fsync_directory(path.parent)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary_path.unlink()


def _relative_bytes(path: str) -> bytes:
    return path.encode("utf-8", "surrogateescape")


def _entry_record(path: Path, relative: str, root_uid: int, root_gid: int) -> dict[str, Any]:
    metadata = os.lstat(path)
    if (metadata.st_uid, metadata.st_gid) != (root_uid, root_gid):
        raise CutoverError(
            f"ownership mismatch for {relative}: {metadata.st_uid}:{metadata.st_gid} "
            f"!= target-root {root_uid}:{root_gid}"
        )
    try:
        xattrs = os.listxattr(path, follow_symlinks=False)
    except OSError as error:
        raise CutoverError(f"cannot inspect xattrs for {relative}: {error}") from error
    if xattrs:
        raise CutoverError(f"unrepresented ACL/xattr state for {relative}: {sorted(xattrs)!r}")

    record: dict[str, Any] = {
        "path": relative,
        "mode": f"{stat.S_IMODE(metadata.st_mode):04o}",
        "owner_policy": "target-root",
    }
    if stat.S_ISDIR(metadata.st_mode):
        record["type"] = "directory"
    elif stat.S_ISREG(metadata.st_mode):
        if metadata.st_nlink != 1:
            raise CutoverError(f"multiply linked regular file is unsupported: {relative}")
        record.update({"type": "file", "size": metadata.st_size, "sha256": sha256_file(path)})
    elif stat.S_ISLNK(metadata.st_mode):
        target = os.readlink(path)
        target_bytes = os.fsencode(target)
        record.update(
            {
                "type": "symlink",
                "target": target,
                "target_sha256": sha256_bytes(target_bytes),
            }
        )
    else:
        raise CutoverError(f"unsupported special file: {relative}")
    return record


def _walk_identity(root: Path, identity: str, uid: int, gid: int) -> list[dict[str, Any]]:
    base = root / identity
    records = [_entry_record(base, identity, uid, gid)]

    def visit(directory: Path, prefix: str) -> None:
        children = sorted(os.scandir(directory), key=lambda item: os.fsencode(item.name))
        for child in children:
            relative = f"{prefix}/{child.name}"
            child_path = Path(child.path)
            record = _entry_record(child_path, relative, uid, gid)
            records.append(record)
            if record["type"] == "directory":
                visit(child_path, relative)

    visit(base, identity)
    return records


def manifest_digest(entries: Iterable[dict[str, Any]], absent: Iterable[str]) -> str:
    digest = hashlib.sha256()
    records: list[dict[str, Any]] = [
        {"kind": "entry", "value": entry} for entry in sorted(entries, key=lambda item: _relative_bytes(item["path"]))
    ]
    records.extend({"kind": "absent", "value": name} for name in sorted(absent, key=_relative_bytes))
    for record in records:
        encoded = canonical_bytes(record)
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
    return digest.hexdigest()


def scan_manifest(root: Path, identities: Iterable[str], expected_uid: int, expected_gid: int) -> dict[str, Any]:
    root = root.resolve(strict=True)
    root_metadata = os.stat(root, follow_symlinks=False)
    if not stat.S_ISDIR(root_metadata.st_mode):
        raise CutoverError(f"skill root is not a directory: {root}")
    entries: list[dict[str, Any]] = []
    absent: list[str] = []
    normalized = sorted(set(identities), key=_relative_bytes)
    unknown = set(normalized) - set(CLOSED_IDENTITIES)
    if unknown:
        raise CutoverError(f"identity outside closed migration set: {sorted(unknown)!r}")
    for identity in normalized:
        path = root / identity
        if path.is_symlink():
            raise CutoverError(f"top-level identity cannot be a symlink: {identity}")
        if not path.exists():
            absent.append(identity)
            continue
        entries.extend(_walk_identity(root, identity, expected_uid, expected_gid))
    digest = manifest_digest(entries, absent)
    return {
        "schema_version": SCHEMA_VERSION,
        "owner_policy": "target-root",
        "identities": normalized,
        "absent_identities": absent,
        "entries": sorted(entries, key=lambda item: _relative_bytes(item["path"])),
        "owned_tree_sha256": digest,
    }



def validate_manifest_integrity(manifest: dict[str, Any], identities: list[str]) -> None:
    entries = manifest.get("entries")
    if manifest.get("schema_version") != SCHEMA_VERSION or not isinstance(entries, list):
        raise CutoverError("manifest structure is invalid")
    paths = [entry.get("path") for entry in entries if isinstance(entry, dict)]
    if len(paths) != len(entries) or paths != sorted(paths, key=_relative_bytes) or len(set(paths)) != len(paths):
        raise CutoverError("manifest paths are not unique canonical byte order")
    allowed = set(identities)
    for path in paths:
        top = path.split("/", 1)[0]
        if top not in allowed or path.startswith("/") or ".." in Path(path).parts:
            raise CutoverError(f"manifest path escapes closed identities: {path}")
    absent = manifest.get("absent_identities")
    if manifest.get("identities") != sorted(set(identities), key=_relative_bytes) or not isinstance(absent, list):
        raise CutoverError("manifest identity binding mismatch")
    if absent != sorted(absent, key=_relative_bytes) or set(absent) - set(identities):
        raise CutoverError("manifest absence binding mismatch")
    observed = manifest_digest(entries, absent)
    if manifest.get("owned_tree_sha256") != observed:
        raise CutoverError("manifest digest does not bind its entries")

def verify_manifest(root: Path, manifest: dict[str, Any], expected_uid: int, expected_gid: int) -> dict[str, Any]:
    if manifest.get("schema_version") != SCHEMA_VERSION:
        raise CutoverError("unsupported manifest schema")
    if manifest.get("owner_policy") != "target-root":
        raise CutoverError("manifest ownership policy must be target-root")
    observed = scan_manifest(root, manifest["identities"], expected_uid, expected_gid)
    if observed != manifest:
        raise CutoverError(
            "manifest mismatch: "
            f"expected {manifest.get('owned_tree_sha256')}, observed {observed.get('owned_tree_sha256')}"
        )
    return observed


def capability_probe(target_root: Path, state_root: Path) -> dict[str, Any]:
    target_root = target_root.resolve(strict=True)
    root_metadata = os.stat(target_root, follow_symlinks=False)
    state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(state_root, 0o700)
    state_metadata = os.stat(state_root, follow_symlinks=False)
    if state_metadata.st_dev != root_metadata.st_dev:
        raise CutoverError("capability scratch must be on the target filesystem")
    probe = Path(tempfile.mkdtemp(prefix="probe-", dir=state_root))
    os.chmod(probe, 0o700)
    uid, gid = root_metadata.st_uid, root_metadata.st_gid
    evidence: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "target_root": str(target_root),
        "target_device": root_metadata.st_dev,
        "target_inode": root_metadata.st_ino,
        "target_uid": uid,
        "target_gid": gid,
        "effective_uid": os.geteuid(),
        "effective_gid": os.getegid(),
        "supplementary_groups": os.getgroups(),
        "started_ns": time.time_ns(),
    }
    try:
        regular = probe / "file"
        directory = probe / "directory"
        referent = probe / "referent"
        link = probe / "link"
        regular.write_bytes(b"probe\n")
        directory.mkdir()
        referent.write_bytes(b"referent\n")
        link.symlink_to(referent.name)
        before_referent = os.lstat(referent)
        file_fd = os.open(regular, os.O_RDONLY | os.O_NOFOLLOW)
        dir_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        referent_fd = os.open(referent, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            os.fchown(file_fd, uid, gid)
            os.fchown(dir_fd, uid, gid)
            os.fchown(referent_fd, uid, gid)
            os.chown(link, uid, gid, follow_symlinks=False)
            os.fchmod(file_fd, 0o640)
            os.fchmod(dir_fd, 0o750)
            os.fchmod(referent_fd, 0o600)
            os.fsync(file_fd)
            os.fsync(dir_fd)
            os.fsync(referent_fd)
        finally:
            os.close(file_fd)
            os.close(dir_fd)
            os.close(referent_fd)
        after_referent = os.lstat(referent)
        file_metadata = os.lstat(regular)
        directory_metadata = os.lstat(directory)
        link_metadata = os.lstat(link)
        if (file_metadata.st_uid, file_metadata.st_gid, stat.S_IMODE(file_metadata.st_mode)) != (uid, gid, 0o640):
            raise CutoverError("regular-file ownership capability verification failed")
        if (directory_metadata.st_uid, directory_metadata.st_gid, stat.S_IMODE(directory_metadata.st_mode)) != (
            uid,
            gid,
            0o750,
        ):
            raise CutoverError("directory ownership capability verification failed")
        if (link_metadata.st_uid, link_metadata.st_gid) != (uid, gid):
            raise CutoverError("no-follow symlink ownership capability verification failed")
        referent_identity = lambda value: (value.st_dev, value.st_ino, value.st_uid, value.st_gid, value.st_size)
        if referent_identity(before_referent) != referent_identity(after_referent):
            raise CutoverError("symlink ownership operation changed the referent")
        fsync_directory(probe)
        evidence.update(
            {
                "status": "passed",
                "file_directory_primitive": "os.fchown",
                "symlink_primitive": "os.chown(follow_symlinks=False)",
                "referent_unchanged": True,
                "file_mode": "0640",
                "directory_mode": "0750",
            }
        )
    except (OSError, NotImplementedError) as error:
        raise CutoverError(f"ownership/filesystem capability probe failed: {error}") from error
    finally:
        for child in sorted(probe.iterdir(), key=lambda item: os.fsencode(item.name), reverse=True):
            if child.is_dir() and not child.is_symlink():
                child.rmdir()
            else:
                child.unlink()
        probe.rmdir()
        fsync_directory(state_root)
    evidence["completed_ns"] = time.time_ns()
    evidence["evidence_sha256"] = sha256_bytes(canonical_bytes(evidence))
    return evidence


def _snapshot_entry(path: Path, relative: str) -> dict[str, Any]:
    metadata = os.lstat(path)
    try:
        xattrs = sorted(os.listxattr(path, follow_symlinks=False))
        xattr_values = {name: sha256_bytes(os.getxattr(path, name, follow_symlinks=False)) for name in xattrs}
    except OSError as error:
        raise CutoverError(f"cannot inspect unrelated metadata for {relative}: {error}") from error
    record: dict[str, Any] = {
        "path": relative,
        "device": metadata.st_dev,
        "inode": metadata.st_ino,
        "nlink": metadata.st_nlink,
        "uid": metadata.st_uid,
        "gid": metadata.st_gid,
        "mode": f"{stat.S_IMODE(metadata.st_mode):04o}",
        "size": metadata.st_size,
        "mtime_ns": metadata.st_mtime_ns,
        "ctime_ns": metadata.st_ctime_ns,
        "xattrs": xattr_values,
    }
    if stat.S_ISDIR(metadata.st_mode):
        record["type"] = "directory"
    elif stat.S_ISREG(metadata.st_mode):
        record.update({"type": "file", "sha256": sha256_file(path)})
    elif stat.S_ISLNK(metadata.st_mode):
        target = os.readlink(path)
        record.update({"type": "symlink", "target_sha256": sha256_bytes(os.fsencode(target))})
    else:
        raise CutoverError(f"unsupported unrelated special file: {relative}")
    return record


def snapshot_unrelated_siblings(target_root: Path, identities: Iterable[str]) -> dict[str, Any]:
    target_root = target_root.resolve(strict=True)
    root_metadata = os.stat(target_root, follow_symlinks=False)
    excluded = set(identities)
    siblings: list[dict[str, Any]] = []

    def visit(path: Path, relative: str, records: list[dict[str, Any]]) -> None:
        record = _snapshot_entry(path, relative)
        records.append(record)
        if record["type"] == "directory":
            for child in sorted(os.scandir(path), key=lambda item: os.fsencode(item.name)):
                visit(Path(child.path), f"{relative}/{child.name}", records)

    for child in sorted(os.scandir(target_root), key=lambda item: os.fsencode(item.name)):
        if child.name in excluded:
            continue
        records: list[dict[str, Any]] = []
        visit(Path(child.path), child.name, records)
        ordered_records = sorted(records, key=lambda item: _relative_bytes(item["path"]))
        sibling_digest = hashlib.sha256()
        for record in ordered_records:
            encoded = canonical_bytes(record)
            sibling_digest.update(len(encoded).to_bytes(8, "big"))
            sibling_digest.update(encoded)
        siblings.append({"name": child.name, "sha256": sibling_digest.hexdigest(), "records": ordered_records})
    binding = {
        "schema_version": SCHEMA_VERSION,
        "target_root": str(target_root),
        "root_device": root_metadata.st_dev,
        "root_inode": root_metadata.st_ino,
        "siblings": siblings,
    }
    return {**binding, "sha256": sha256_bytes(canonical_bytes(binding))}


def canonicalize_targets(targets: Iterable[Path]) -> list[dict[str, Any]]:
    grouped: dict[tuple[int, int], dict[str, Any]] = {}
    for supplied in targets:
        label = str(supplied.absolute())
        canonical = supplied.resolve(strict=True)
        metadata = os.stat(canonical, follow_symlinks=False)
        if not stat.S_ISDIR(metadata.st_mode):
            raise CutoverError(f"target root is not a directory: {supplied}")
        key = (metadata.st_dev, metadata.st_ino)
        member = grouped.setdefault(
            key,
            {
                "target": str(canonical),
                "device": metadata.st_dev,
                "inode": metadata.st_ino,
                "uid": metadata.st_uid,
                "gid": metadata.st_gid,
                "aliases": [],
            },
        )
        member["aliases"].append(label)
    members = sorted(grouped.values(), key=lambda item: (item["device"], item["inode"], _relative_bytes(item["target"])))
    for member in members:
        member["aliases"] = sorted(set(member["aliases"]), key=_relative_bytes)
    return members


def derive_set_id(
    operation: str,
    source_root: Path,
    member_bindings: list[dict[str, Any]],
    identities: Iterable[str],
    expected_manifest: dict[str, Any],
    desired_manifest: dict[str, Any],
    parent_set_id: str | None = None,
) -> str:
    payload = {
        "operation": operation,
        "source_root": str(source_root.resolve(strict=True)),
        "source_revision": desired_manifest["owned_tree_sha256"],
        "members": [
            {
                "target": member["target"],
                "device": member["device"],
                "inode": member["inode"],
                "aliases": member["aliases"],
                "expected_state_sha256": member["expected_state_sha256"],
                "sentinel_sha256": member["sentinel_sha256"],
            }
            for member in sorted(member_bindings, key=lambda item: (item["device"], item["inode"], _relative_bytes(item["target"])))
        ],
        "identities": sorted(identities, key=_relative_bytes),
        "expected_digest": expected_manifest["owned_tree_sha256"],
        "desired_digest": desired_manifest["owned_tree_sha256"],
        "parent_set_id": parent_set_id,
    }
    return "ds-" + sha256_bytes(canonical_bytes(payload))



def bind_receipt(payload: dict[str, Any]) -> dict[str, Any]:
    return {**payload, "receipt_sha256": sha256_bytes(canonical_bytes(payload))}


def verify_receipt(receipt: dict[str, Any], expected: dict[str, Any]) -> None:
    if any(receipt.get(key) != value for key, value in expected.items()):
        raise CutoverError("receipt binding mismatch")
    claimed = receipt.get("receipt_sha256")
    unsigned = dict(receipt)
    unsigned.pop("receipt_sha256", None)
    if claimed != sha256_bytes(canonical_bytes(unsigned)):
        raise CutoverError("receipt digest mismatch")

def set_binding(intent: dict[str, Any]) -> dict[str, Any]:
    return {
        "transaction_id": intent["set_id"],
        "set_id": intent["set_id"],
        "operation": intent["operation"],
        "parent_set_id": intent.get("parent_set_id"),
    }


def member_binding(intent: dict[str, Any], member: dict[str, Any]) -> dict[str, Any]:
    return {
        "transaction_id": member["member_id"],
        "set_id": intent["set_id"],
        "member_id": member["member_id"],
        "operation": intent["operation"],
        "target": member["target"],
        "device": member["device"],
        "inode": member["inode"],
    }


_SET_TRANSITIONS: dict[str | None, set[str]] = {
    None: {"set-initializing"},
    "set-initializing": {"set-prepared", "set-recovered"},
    "set-prepared": {"set-applying", "set-recovered"},
    "set-applying": {"set-committed", "set-recovered"},
    "set-committed": {"post-validation-passed", "post-validation-failed", "rollback-validation-passed"},
    "post-validation-passed": {"cleanup-complete", "cleanup-failed"},
    "post-validation-failed": set(),
    "rollback-validation-passed": {"rollback-cleanup-complete", "cleanup-failed"},
    "set-recovered": {"cleanup-complete", "cleanup-failed"},
    "cleanup-complete": set(),
    "rollback-cleanup-complete": set(),
    "cleanup-failed": {"cleanup-failed", "cleanup-complete", "rollback-cleanup-complete"},
}
_MEMBER_TRANSITIONS: dict[str | None, set[str]] = {
    None: {"initializing", "aborted-no-write"},
    "initializing": {"prepared", "aborted-no-write"},
    "prepared": {"applying", "aborted-no-write"},
    "applying": {"committed", "recovering", "aborted-stale"},
    "committed": {"recovering"},
    "recovering": {"recovered", "committed"},
    "recovered": set(),
    "aborted-no-write": set(),
    "aborted-stale": set(),
}


class Journal:
    def __init__(self, path: Path, binding: dict[str, Any], kind: str):
        if kind not in {"set", "member"}:
            raise CutoverError(f"invalid journal kind: {kind}")
        if not binding.get("transaction_id") or not binding.get("operation"):
            raise CutoverError("journal binding requires transaction_id and operation")
        self.path = path
        self.binding = binding
        self.kind = kind
        self.path.mkdir(parents=True, exist_ok=True, mode=0o700)

    def _paths(self) -> list[Path]:
        paths: list[Path] = []
        for child in sorted(self.path.iterdir(), key=lambda item: os.fsencode(item.name)):
            if child.is_symlink() or not child.is_file():
                raise CutoverError(f"unexpected journal entry: {child}")
            if len(child.name) != 13 or not child.name[:8].isdigit() or child.name[8:] != ".json":
                raise CutoverError(f"malformed trailing journal entry: {child.name}")
            paths.append(child)
        expected_names = [f"{index:08d}.json" for index in range(1, len(paths) + 1)]
        observed_names = [path.name for path in paths]
        if observed_names != expected_names:
            raise CutoverError(f"journal sequence gap or fork: expected {expected_names}, observed {observed_names}")
        return paths

    def _validate_transition(self, previous: str | None, phase: str) -> None:
        transitions = _SET_TRANSITIONS if self.kind == "set" else _MEMBER_TRANSITIONS
        if phase not in transitions.get(previous, set()):
            raise CutoverError(f"invalid {self.kind} phase transition: {previous!r} -> {phase!r}")
        operation = self.binding["operation"]
        if self.kind == "set":
            if phase == "rollback-validation-passed" and operation != "baseline-v1":
                raise CutoverError("operation/phase mismatch for rollback validation")
            if phase in {"post-validation-passed", "post-validation-failed"} and operation != "cutover-v1":
                raise CutoverError("operation/phase mismatch for cutover validation")
        else:
            if previous == "committed" and phase == "recovering" and operation != "cutover-v1":
                raise CutoverError("baseline committed member cannot enter recovering")
            if previous == "recovering" and phase == "recovered" and operation != "cutover-v1":
                raise CutoverError("baseline member cannot record recovered")
            if previous == "recovering" and phase == "committed" and operation != "baseline-v1":
                raise CutoverError("cutover member cannot recommit from recovering")

    def read_all(self) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        previous_digest: str | None = None
        previous_phase: str | None = None
        for expected_sequence, path in enumerate(self._paths(), start=1):
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise CutoverError(f"malformed journal record {path}: {error}") from error
            if record.get("sequence") != expected_sequence:
                raise CutoverError(f"journal duplicate or sequence mismatch at {path}")
            if record.get("previous_record_sha256") != previous_digest:
                raise CutoverError(f"journal chain mismatch at {path}")
            if record.get("binding") != self.binding:
                raise CutoverError(f"journal transaction binding mismatch at {path}")
            phase = record.get("phase")
            if not isinstance(phase, str):
                raise CutoverError(f"journal phase missing at {path}")
            claimed_digest = record.get("record_sha256")
            unsigned = dict(record)
            unsigned.pop("record_sha256", None)
            observed_digest = sha256_bytes(canonical_bytes(unsigned))
            if claimed_digest != observed_digest:
                raise CutoverError(f"journal digest mismatch at {path}")
            self._validate_transition(previous_phase, phase)
            previous_digest = claimed_digest
            previous_phase = phase
            records.append(record)
        return records

    def append(self, phase: str, data: dict[str, Any]) -> dict[str, Any]:
        records = self.read_all()
        previous_phase = records[-1]["phase"] if records else None
        self._validate_transition(previous_phase, phase)
        sequence = len(records) + 1
        previous = records[-1]["record_sha256"] if records else None
        unsigned = {
            "schema_version": SCHEMA_VERSION,
            "sequence": sequence,
            "previous_record_sha256": previous,
            "binding": self.binding,
            "phase": phase,
            "timestamp_ns": time.time_ns(),
            "data": data,
        }
        record = {**unsigned, "record_sha256": sha256_bytes(canonical_bytes(unsigned))}
        atomic_json(self.path / f"{sequence:08d}.json", record)
        return record

    def last_phase(self) -> str | None:
        records = self.read_all()
        return records[-1]["phase"] if records else None

def _copy_entry(source: Path, destination: Path, uid: int, gid: int) -> None:
    metadata = os.lstat(source)
    if stat.S_ISDIR(metadata.st_mode):
        destination.mkdir(mode=0o700)
        descriptor = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fchown(descriptor, uid, gid)
            for child in sorted(os.scandir(source), key=lambda item: os.fsencode(item.name)):
                _copy_entry(Path(child.path), destination / child.name, uid, gid)
            os.fchmod(descriptor, stat.S_IMODE(metadata.st_mode))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    elif stat.S_ISREG(metadata.st_mode):
        destination.parent.mkdir(parents=True, exist_ok=True)
        with source.open("rb") as input_handle, destination.open("xb") as output_handle:
            shutil.copyfileobj(input_handle, output_handle)
            output_handle.flush()
            os.fsync(output_handle.fileno())
        descriptor = os.open(destination, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            os.fchown(descriptor, uid, gid)
            os.fchmod(descriptor, stat.S_IMODE(metadata.st_mode))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    elif stat.S_ISLNK(metadata.st_mode):
        destination.symlink_to(os.readlink(source))
        os.chown(destination, uid, gid, follow_symlinks=False)
    else:
        raise CutoverError(f"unsupported staged entry: {source}")
    fsync_directory(destination.parent)


def _copy_identity(source_root: Path, destination_root: Path, identity: str, uid: int, gid: int) -> None:
    source = source_root / identity
    destination = destination_root / identity
    if not source.exists() and not source.is_symlink():
        return
    _copy_entry(source, destination, uid, gid)


def _remove_path(path: Path) -> None:
    if not path.exists() and not path.is_symlink():
        return
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink()
    fsync_directory(path.parent)


def _member_id(member: dict[str, Any]) -> str:
    identity = f"{member['device']}:{member['inode']}:{member['target']}".encode("utf-8")
    return "member-" + sha256_bytes(identity)[:20]


class DeploymentCoordinator:
    def __init__(self, state_root: Path):
        self.state_root = state_root
        self.sets_root = state_root / "sets"
        self.state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.sets_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.state_root, 0o700)
        os.chmod(self.sets_root, 0o700)
        self.lock_path = state_root / "coordinator.lock"

    @contextlib.contextmanager
    def _global_lock(self):
        descriptor = os.open(self.lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    @contextlib.contextmanager
    def _member_locks(self, members: list[dict[str, Any]]):
        descriptors: list[int] = []
        ordered = sorted(members, key=lambda item: (item["device"], item["inode"], _relative_bytes(item["target"])))
        try:
            for member in ordered:
                lock_root = Path(member["target"]).parent / ".omp-skill-cutover-locks"
                lock_root.mkdir(parents=True, exist_ok=True, mode=0o700)
                os.chmod(lock_root, 0o700)
                descriptor = os.open(lock_root / f"{member['member_id']}.lock", os.O_CREAT | os.O_RDWR, 0o600)
                fcntl.flock(descriptor, fcntl.LOCK_EX)
                descriptors.append(descriptor)
            yield
        finally:
            for descriptor in reversed(descriptors):
                fcntl.flock(descriptor, fcntl.LOCK_UN)
                os.close(descriptor)

    def _set_dir(self, set_id: str) -> Path:
        if not set_id.startswith("ds-") or len(set_id) != 67:
            raise CutoverError(f"invalid set ID: {set_id}")
        return self.sets_root / set_id

    def _intent(self, set_id: str) -> dict[str, Any]:
        path = self._set_dir(set_id) / "intent.json"
        try:
            intent = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise CutoverError(f"invalid set intent for {set_id}: {error}") from error
        if intent.get("set_id") != set_id:
            raise CutoverError(f"set intent identity mismatch for {set_id}")
        identities = intent.get("identities")
        members = intent.get("members")
        if not isinstance(identities, list) or not isinstance(members, list) or not members:
            raise CutoverError(f"set intent structure mismatch for {set_id}")
        validate_manifest_integrity(intent.get("expected_manifest", {}), identities)
        validate_manifest_integrity(intent.get("desired_manifest", {}), identities)
        recomputed = derive_set_id(
            intent.get("operation", ""),
            Path(intent.get("source_root", "")),
            members,
            identities,
            intent["expected_manifest"],
            intent["desired_manifest"],
            intent.get("parent_set_id"),
        )
        if recomputed != set_id:
            raise CutoverError(f"set intent digest binding mismatch for {set_id}")
        for index, member in enumerate(members):
            if member.get("index") != index or member.get("member_id") != _member_id(member):
                raise CutoverError(f"member identity binding mismatch for {set_id}")
            observed_sentinel_sha256 = sha256_bytes(canonical_bytes(member.get("sentinel")))
            expected_state = {
                "target": member.get("target"),
                "device": member.get("device"),
                "inode": member.get("inode"),
                "uid": member.get("uid"),
                "gid": member.get("gid"),
                "expected_digest": intent["expected_manifest"]["owned_tree_sha256"],
                "sentinel_sha256": observed_sentinel_sha256,
            }
            if member.get("sentinel_sha256") != observed_sentinel_sha256 or member.get("expected_state_sha256") != sha256_bytes(canonical_bytes(expected_state)):
                raise CutoverError(f"member sentinel/state binding mismatch for {set_id}")
            expected_workspace = str(self._workspace(Path(member["target"]), set_id, member["member_id"]))
            if member.get("workspace") != expected_workspace:
                raise CutoverError(f"member workspace binding mismatch for {set_id}")
        return intent

    def _set_journal(self, intent: dict[str, Any]) -> Journal:
        return Journal(self._set_dir(intent["set_id"]) / "records", set_binding(intent), "set")

    def _member_journal(self, intent: dict[str, Any], member: dict[str, Any]) -> Journal:
        return Journal(Path(member["workspace"]) / "records", member_binding(intent, member), "member")

    def _root_chain_closed(self, intent: dict[str, Any], records: list[dict[str, Any]]) -> bool:
        if not records:
            return False
        phase = records[-1]["phase"]
        if phase in {"cleanup-complete", "rollback-cleanup-complete"}:
            try:
                verify_receipt(
                    records[-1]["data"],
                    {
                        "schema_version": SCHEMA_VERSION,
                        "set_id": intent["set_id"],
                        "operation": intent["operation"],
                        "terminal_phase": phase,
                        "retained_records": True,
                    },
                )
            except CutoverError:
                return False
            return True
        if phase != "post-validation-failed":
            return False
        try:
            verify_receipt(
                records[-1]["data"],
                {
                    "schema_version": SCHEMA_VERSION,
                    "set_id": intent["set_id"],
                    "operation": "cutover-v1",
                    "phase": "post-validation-failed",
                    "desired_digest": intent["desired_manifest"]["owned_tree_sha256"],
                    "checked_members": [member["member_id"] for member in intent["members"]],
                },
            )
        except CutoverError:
            return False
        child_id = records[-1]["data"].get("child_set_id")
        if not isinstance(child_id, str):
            return False
        child_dir = self._set_dir(child_id)
        if not child_dir.exists():
            return False
        child_intent = self._intent(child_id)
        if child_intent.get("parent_set_id") != intent["set_id"] or child_intent.get("operation") != "baseline-v1":
            return False
        child_records = self._set_journal(child_intent).read_all()
        return self._root_chain_closed(child_intent, child_records)

    def assert_admission_clear(self, resumed_set_id: str | None, allowed_parent_id: str | None = None) -> None:
        for candidate in sorted(self.sets_root.iterdir(), key=lambda path: os.fsencode(path.name)):
            if not candidate.is_dir() or candidate.is_symlink():
                raise CutoverError(f"unexpected coordinator-root entry: {candidate}")
            records_path = candidate / "records"
            if not records_path.exists() or not any(records_path.iterdir()):
                if candidate.name != resumed_set_id:
                    raise CutoverError(f"unbound pre-journal set candidate blocks admission: {candidate.name}")
                self._intent(candidate.name)
                continue
            intent = self._intent(candidate.name)
            records = self._set_journal(intent).read_all()
            if candidate.name in {resumed_set_id, allowed_parent_id}:
                continue
            if not self._root_chain_closed(intent, records):
                raise CutoverError(f"lifecycle-active set blocks admission: {candidate.name} at {records[-1]['phase']}")

    def _raise_failpoint(self, configured: str | None, observed: str, set_id: str) -> None:
        if configured == observed:
            raise InjectedCrash(set_id, observed)

    def _workspace(self, target: Path, set_id: str, member_id: str) -> Path:
        return target.parent / ".omp-skill-cutover" / set_id / member_id

    def _capture_member_state(
        self,
        members: list[dict[str, Any]],
        identities: list[str],
        expected_manifest: dict[str, Any],
    ) -> list[dict[str, Any]]:
        captured = [dict(member) for member in members]
        for member in captured:
            target = Path(member["target"])
            metadata = os.stat(target, follow_symlinks=False)
            verify_manifest(target, expected_manifest, metadata.st_uid, metadata.st_gid)
            sentinel = snapshot_unrelated_siblings(target, identities)
            sentinel_sha256 = sha256_bytes(canonical_bytes(sentinel))
            state = {
                "target": member["target"],
                "device": member["device"],
                "inode": member["inode"],
                "uid": member["uid"],
                "gid": member["gid"],
                "expected_digest": expected_manifest["owned_tree_sha256"],
                "sentinel_sha256": sentinel_sha256,
            }
            member["sentinel"] = sentinel
            member["sentinel_sha256"] = sentinel_sha256
            member["expected_state_sha256"] = sha256_bytes(canonical_bytes(state))
        return captured

    def _prebind_members(
        self,
        targets: list[Path],
        identities: list[str],
        expected_manifest: dict[str, Any],
    ) -> list[dict[str, Any]]:
        members = canonicalize_targets(targets)
        for member in members:
            member["member_id"] = _member_id(member)
        with self._member_locks(members):
            return self._capture_member_state(members, identities, expected_manifest)

    def _build_members(self, prebound: list[dict[str, Any]], set_id: str) -> list[dict[str, Any]]:
        members = [dict(member) for member in prebound]
        for index, member in enumerate(members):
            member["index"] = index
            member["workspace"] = str(self._workspace(Path(member["target"]), set_id, member["member_id"]))
        return members

    def _persist_intent(self, intent: dict[str, Any]) -> None:
        atomic_json(self._set_dir(intent["set_id"]) / "intent.json", intent)

    def _prepare_member(self, intent: dict[str, Any], member: dict[str, Any], failpoint: str | None) -> None:
        set_id = intent["set_id"]
        target = Path(member["target"])
        source = Path(intent["source_root"])
        metadata = os.stat(target, follow_symlinks=False)
        if (metadata.st_dev, metadata.st_ino, metadata.st_uid, metadata.st_gid) != (
            member["device"], member["inode"], member["uid"], member["gid"]
        ):
            raise CutoverError(f"target identity changed before prepare: {target}")
        capability = capability_probe(target, self.state_root / "capability-probes" / member["member_id"])
        verify_manifest(target, intent["expected_manifest"], metadata.st_uid, metadata.st_gid)
        member["capability_evidence_sha256"] = capability["evidence_sha256"]
        observed_sentinel = snapshot_unrelated_siblings(target, intent["identities"])
        if observed_sentinel != member["sentinel"] or sha256_bytes(canonical_bytes(observed_sentinel)) != member["sentinel_sha256"]:
            raise CutoverError(f"prebound unrelated sentinel changed before prepare: {target}")
        self._persist_intent(intent)
        workspace = Path(member["workspace"])
        workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
        stage = workspace / "stage"
        rollback = workspace / "rollback"
        _remove_path(stage)
        _remove_path(rollback)
        stage.mkdir(mode=0o700)
        rollback.mkdir(mode=0o700)
        for identity in intent["identities"]:
            _copy_identity(source, stage, identity, metadata.st_uid, metadata.st_gid)
            _copy_identity(target, rollback, identity, metadata.st_uid, metadata.st_gid)
        verify_manifest(stage, intent["desired_manifest"], metadata.st_uid, metadata.st_gid)
        verify_manifest(rollback, intent["expected_manifest"], metadata.st_uid, metadata.st_gid)
        atomic_json(workspace / "member.json", member)
        self._member_journal(intent, member).append("prepared", {"target": str(target)})
        self._raise_failpoint(failpoint, f"after-member-prepared:{member['index']}", set_id)

    def _replace_with_tree(self, target: Path, tree: Path, identities: list[str], trash: Path) -> None:
        trash.mkdir(parents=True, exist_ok=True, mode=0o700)
        for identity in identities:
            target_path = target / identity
            trash_path = trash / identity
            _remove_path(trash_path)
            if target_path.exists() or target_path.is_symlink():
                os.replace(target_path, trash_path)
                fsync_directory(target)
            staged_path = tree / identity
            if staged_path.exists() or staged_path.is_symlink():
                os.replace(staged_path, target_path)
                fsync_directory(target)

    def _restage(self, intent: dict[str, Any], member: dict[str, Any]) -> Path:
        target = Path(member["target"])
        source = Path(intent["source_root"])
        workspace = Path(member["workspace"])
        stage = workspace / "stage"
        _remove_path(stage)
        stage.mkdir(parents=True, mode=0o700)
        metadata = os.stat(target, follow_symlinks=False)
        for identity in intent["identities"]:
            _copy_identity(source, stage, identity, metadata.st_uid, metadata.st_gid)
        verify_manifest(stage, intent["desired_manifest"], metadata.st_uid, metadata.st_gid)
        return stage

    def _verify_member_identity(self, member: dict[str, Any]) -> os.stat_result:
        target = Path(member["target"])
        metadata = os.stat(target, follow_symlinks=False)
        if (metadata.st_dev, metadata.st_ino, metadata.st_uid, metadata.st_gid) != (
            member["device"], member["inode"], member["uid"], member["gid"]
        ):
            raise CutoverError(f"target identity changed: {target}")
        return metadata

    def _verify_member_identity_and_probe(self, intent: dict[str, Any], member: dict[str, Any]) -> os.stat_result:
        target = Path(member["target"])
        metadata = self._verify_member_identity(member)
        evidence = capability_probe(target, self.state_root / "capability-probes" / member["member_id"])
        if evidence["target_device"] != member["device"] or evidence["target_inode"] != member["inode"]:
            raise CutoverError(f"capability evidence target mismatch: {target}")
        return metadata

    def _apply_member(self, intent: dict[str, Any], member: dict[str, Any], failpoint: str | None) -> None:
        set_id = intent["set_id"]
        target = Path(member["target"])
        workspace = Path(member["workspace"])
        journal = self._member_journal(intent, member)
        phase = journal.last_phase()
        if phase == "committed":
            metadata = self._verify_member_identity_and_probe(intent, member)
            verify_manifest(target, intent["desired_manifest"], metadata.st_uid, metadata.st_gid)
            return
        if phase != "prepared":
            raise CutoverError(f"member cannot begin apply from phase {phase}")
        self._verify_member_identity_and_probe(intent, member)
        journal.append("applying", {"set_id": set_id})
        self._raise_failpoint(failpoint, f"after-member-applying:{member['index']}", set_id)
        if snapshot_unrelated_siblings(target, intent["identities"]) != member["sentinel"]:
            journal.append("aborted-stale", {"reason": "unrelated sentinel drift"})
            raise CutoverError(f"unrelated sibling drift for {target}")
        stage = workspace / "stage"
        trash = workspace / f"trash-{time.time_ns()}"
        self._replace_with_tree(target, stage, intent["identities"], trash)
        self._raise_failpoint(failpoint, f"after-member-replaced:{member['index']}", set_id)
        metadata = os.stat(target, follow_symlinks=False)
        verify_manifest(target, intent["desired_manifest"], metadata.st_uid, metadata.st_gid)
        if snapshot_unrelated_siblings(target, intent["identities"]) != member["sentinel"]:
            raise CutoverError(f"unrelated sibling changed during apply for {target}")
        journal.append("committed", {"desired_digest": intent["desired_manifest"]["owned_tree_sha256"]})
        self._raise_failpoint(failpoint, f"after-member-committed:{member['index']}", set_id)

    def _resume_baseline_member(self, intent: dict[str, Any], member: dict[str, Any]) -> None:
        target = Path(member["target"])
        journal = self._member_journal(intent, member)
        phase = journal.last_phase()
        metadata = self._verify_member_identity_and_probe(intent, member)
        if phase == "committed":
            verify_manifest(target, intent["desired_manifest"], metadata.st_uid, metadata.st_gid)
            return
        if phase == "prepared":
            self._apply_member(intent, member, None)
            return
        if phase == "applying":
            journal.append("recovering", {"operation": "baseline-v1"})
        elif phase != "recovering":
            raise CutoverError(f"baseline member cannot resume from {phase}")
        stage = self._restage(intent, member)
        self._replace_with_tree(target, stage, intent["identities"], Path(member["workspace"]) / f"resume-trash-{time.time_ns()}")
        verify_manifest(target, intent["desired_manifest"], metadata.st_uid, metadata.st_gid)
        if snapshot_unrelated_siblings(target, intent["identities"]) != member["sentinel"]:
            raise CutoverError(f"unrelated sibling changed during baseline recovery for {target}")
        journal.append("committed", {"desired_digest": intent["desired_manifest"]["owned_tree_sha256"]})

    def _restore_cutover_member(self, intent: dict[str, Any], member: dict[str, Any]) -> None:
        target = Path(member["target"])
        workspace = Path(member["workspace"])
        workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
        journal = self._member_journal(intent, member)
        phase = journal.last_phase()
        metadata = self._verify_member_identity_and_probe(intent, member)
        if snapshot_unrelated_siblings(target, intent["identities"]) != member["sentinel"]:
            raise CutoverError(f"unrelated sibling drift during cutover recovery for {target}")
        try:
            verify_manifest(target, intent["expected_manifest"], metadata.st_uid, metadata.st_gid)
            already_expected = True
        except CutoverError:
            already_expected = False
        if phase in {"recovered", "aborted-no-write"} and already_expected:
            return
        if phase in {None, "initializing", "prepared"} and already_expected:
            journal.append("aborted-no-write", {"reason": "proven no-effect member"})
            return
        if phase not in {"applying", "committed", "recovering"}:
            raise CutoverError(f"cannot recover cutover member from {phase}")
        if phase != "recovering":
            journal.append("recovering", {"operation": "cutover-v1"})
        rollback = workspace / "rollback"
        if not rollback.exists():
            raise CutoverError(f"rollback payload missing for {target}")
        restore = workspace / f"restore-{time.time_ns()}"
        restore.mkdir(parents=True, mode=0o700)
        for identity in intent["identities"]:
            _copy_identity(rollback, restore, identity, metadata.st_uid, metadata.st_gid)
        self._replace_with_tree(target, restore, intent["identities"], workspace / f"failed-cutover-{time.time_ns()}")
        verify_manifest(target, intent["expected_manifest"], metadata.st_uid, metadata.st_gid)
        journal.append("recovered", {"expected_digest": intent["expected_manifest"]["owned_tree_sha256"]})

    def _validate_parent_binding(self, parent_set_id: str, child_set_id: str, desired_manifest: dict[str, Any]) -> dict[str, Any]:
        parent = self._intent(parent_set_id)
        if parent["operation"] != "cutover-v1":
            raise CutoverError("baseline-v1 requires a receipt-bound cutover parent")
        records = self._set_journal(parent).read_all()
        if not records or records[-1]["phase"] != "post-validation-failed":
            raise CutoverError("baseline-v1 requires a receipt-bound parent validation failure")
        data = records[-1]["data"]
        verify_receipt(
            data,
            {
                "schema_version": SCHEMA_VERSION,
                "set_id": parent_set_id,
                "operation": "cutover-v1",
                "phase": "post-validation-failed",
                "desired_digest": parent["desired_manifest"]["owned_tree_sha256"],
                "checked_members": [member["member_id"] for member in parent["members"]],
                "child_set_id": child_set_id,
                "baseline_digest": desired_manifest["owned_tree_sha256"],
            },
        )
        return parent

    def record_validation_failure(
        self,
        parent_set_id: str,
        baseline_source_root: Path,
        targets: list[Path],
        identities: list[str],
        baseline_manifest: dict[str, Any],
    ) -> str:
        with self._global_lock():
            parent = self._intent(parent_set_id)
            members = parent["members"]
            with self._member_locks(members):
                journal = self._set_journal(parent)
                records = journal.read_all()
                child_bindings = self._capture_member_state(members, identities, parent["desired_manifest"])
                child_id = derive_set_id(
                    "baseline-v1",
                    baseline_source_root,
                    child_bindings,
                    identities,
                    parent["desired_manifest"],
                    baseline_manifest,
                    parent_set_id,
                )
                if records[-1]["phase"] == "post-validation-failed":
                    if records[-1]["data"].get("child_set_id") != child_id:
                        raise CutoverError("parent is already bound to a different rollback child")
                    return child_id
                if records[-1]["phase"] != "set-committed":
                    raise CutoverError("cutover validation failure requires set-committed")
                journal.append(
                    "post-validation-failed",
                    bind_receipt(
                        {
                            "schema_version": SCHEMA_VERSION,
                            "set_id": parent_set_id,
                            "operation": "cutover-v1",
                            "phase": "post-validation-failed",
                            "desired_digest": parent["desired_manifest"]["owned_tree_sha256"],
                            "checked_members": [member["member_id"] for member in members],
                            "child_set_id": child_id,
                            "baseline_source_root": str(baseline_source_root.resolve(strict=True)),
                            "baseline_digest": baseline_manifest["owned_tree_sha256"],
                        }
                    ),
                )
                return child_id

    def run_member_mode(
        self,
        mode: str,
        set_id: str,
        source_root: Path,
        target_root: Path,
        manifest: dict[str, Any],
        expected_target_state: dict[str, Any],
        set_journal: Path,
    ) -> dict[str, Any]:
        if mode not in {"check", "prepare", "apply", "recover"}:
            raise CutoverError(f"unsupported member mode: {mode}")
        with self._global_lock():
            intent = self._intent(set_id)
            expected_journal = (self._set_dir(set_id) / "records").resolve(strict=True)
            if set_journal.resolve(strict=True) != expected_journal:
                raise CutoverError("member command is not authorized by the exact set journal")
            if source_root.resolve(strict=True) != Path(intent["source_root"]).resolve(strict=True):
                raise CutoverError("member source root does not match set intent")
            if manifest != intent["desired_manifest"] or expected_target_state != intent["expected_manifest"]:
                raise CutoverError("member manifest/expected state does not match set intent")
            canonical = target_root.resolve(strict=True)
            matches = [member for member in intent["members"] if member["target"] == str(canonical)]
            if len(matches) != 1:
                raise CutoverError("member target is not uniquely referenced by the set")
            member = matches[0]
            with self._member_locks([member]):
                set_phase = self._set_journal(intent).last_phase()
                member_journal = self._member_journal(intent, member)
                member_phase = member_journal.last_phase()
                if mode == "check":
                    metadata = self._verify_member_identity(member)
                    if member_phase in {"initializing", "prepared", "aborted-no-write", "recovered"}:
                        verify_manifest(canonical, intent["expected_manifest"], metadata.st_uid, metadata.st_gid)
                    elif member_phase == "committed":
                        verify_manifest(canonical, intent["desired_manifest"], metadata.st_uid, metadata.st_gid)
                    if snapshot_unrelated_siblings(canonical, intent["identities"]) != member["sentinel"]:
                        raise CutoverError("member unrelated sentinel drift")
                    return {"set_id": set_id, "member_id": member["member_id"], "set_phase": set_phase, "member_phase": member_phase}
                if mode == "prepare":
                    if set_phase != "set-initializing" or member_phase != "initializing":
                        raise CutoverError("prepare requires coordinator set-initializing/member-initializing authorization")
                    self._prepare_member(intent, member, None)
                elif mode == "apply":
                    if set_phase != "set-applying" or member_phase != "prepared":
                        raise CutoverError("apply requires coordinator set-applying/member-prepared authorization")
                    self._apply_member(intent, member, None)
                else:
                    if set_phase not in {"set-initializing", "set-prepared", "set-applying"}:
                        raise CutoverError("recover requires an incomplete coordinator set")
                    if intent["operation"] == "cutover-v1":
                        self._restore_cutover_member(intent, member)
                    else:
                        self._validate_parent_binding(intent.get("parent_set_id") or "", set_id, intent["desired_manifest"])
                        self._resume_baseline_member(intent, member)
                return {
                    "set_id": set_id,
                    "member_id": member["member_id"],
                    "set_phase": self._set_journal(intent).last_phase(),
                    "member_phase": self._member_journal(intent, member).last_phase(),
                }

    def start_set(
        self,
        operation: str,
        source_root: Path,
        targets: list[Path],
        identities: list[str],
        expected_manifest: dict[str, Any],
        desired_manifest: dict[str, Any],
        parent_set_id: str | None = None,
        failpoint: str | None = None,
    ) -> dict[str, Any]:
        if operation not in {"cutover-v1", "baseline-v1"}:
            raise CutoverError(f"unsupported operation: {operation}")
        if operation == "baseline-v1" and not parent_set_id:
            raise CutoverError("baseline-v1 requires a receipt-bound parent")
        if operation == "cutover-v1" and parent_set_id:
            raise CutoverError("cutover-v1 cannot have a parent set")
        source_root = source_root.resolve(strict=True)
        with self._global_lock():
            prebound = self._prebind_members(targets, identities, expected_manifest)
            set_id = derive_set_id(operation, source_root, prebound, identities, expected_manifest, desired_manifest, parent_set_id)
            members = self._build_members(prebound, set_id)
            set_dir = self._set_dir(set_id)
            if operation == "baseline-v1":
                self._validate_parent_binding(parent_set_id or "", set_id, desired_manifest)
            self.assert_admission_clear(None, parent_set_id)
            if set_dir.exists():
                raise CutoverError(f"set already exists; resume instead: {set_id}")
            set_dir.mkdir(mode=0o700)
            intent = {
                "schema_version": SCHEMA_VERSION,
                "set_id": set_id,
                "operation": operation,
                "parent_set_id": parent_set_id,
                "source_root": str(source_root),
                "identities": sorted(identities, key=_relative_bytes),
                "expected_manifest": expected_manifest,
                "desired_manifest": desired_manifest,
                "members": members,
            }
            self._persist_intent(intent)
            self._raise_failpoint(failpoint, "after-set-directory-before-first-record", set_id)
            set_journal = self._set_journal(intent)
            set_journal.append("set-initializing", {"members": [member["member_id"] for member in members]})
            with self._member_locks(members):
                for member in members:
                    workspace = Path(member["workspace"])
                    workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
                    self._member_journal(intent, member).append("initializing", {})
                    self._prepare_member(intent, member, failpoint)
                self._persist_intent(intent)
                set_journal.append("set-prepared", {"member_count": len(members)})
                self._raise_failpoint(failpoint, "after-set-prepared", set_id)
                set_journal.append("set-applying", {"member_count": len(members)})
                self._raise_failpoint(failpoint, "after-set-applying", set_id)
                for member in members:
                    self._apply_member(intent, member, failpoint)
                set_journal.append("set-committed", {"desired_digest": desired_manifest["owned_tree_sha256"]})
            return {"set_id": set_id, "phase": "set-committed", "member_count": len(members)}

    def _restart_prejournal(self, intent: dict[str, Any]) -> dict[str, Any]:
        for member in intent["members"]:
            workspace = Path(member["workspace"])
            if workspace.exists():
                raise CutoverError("pre-journal set has member state and cannot be restarted as no-effect")
            target = Path(member["target"])
            metadata = os.stat(target, follow_symlinks=False)
            verify_manifest(target, intent["expected_manifest"], metadata.st_uid, metadata.st_gid)
        set_dir = self._set_dir(intent["set_id"])
        shutil.rmtree(set_dir)
        fsync_directory(self.sets_root)
        return {
            "operation": intent["operation"],
            "source_root": Path(intent["source_root"]),
            "targets": [Path(alias) for member in intent["members"] for alias in member["aliases"]],
            "identities": intent["identities"],
            "expected_manifest": intent["expected_manifest"],
            "desired_manifest": intent["desired_manifest"],
            "parent_set_id": intent.get("parent_set_id"),
        }

    def _validate_set_member_matrix(self, intent: dict[str, Any], set_phase: str) -> None:
        phases = [self._member_journal(intent, member).last_phase() for member in intent["members"]]
        if set_phase == "set-initializing":
            allowed: set[str | None] = {None, "initializing", "prepared"}
        elif set_phase == "set-prepared":
            allowed = {"prepared"}
        elif set_phase == "set-applying" and intent["operation"] == "cutover-v1":
            allowed = {"prepared", "applying", "committed", "recovering", "recovered", "aborted-no-write"}
        elif set_phase == "set-applying":
            allowed = {"prepared", "applying", "recovering", "committed"}
        elif set_phase == "set-committed":
            allowed = {"committed"}
        elif set_phase == "set-recovered":
            allowed = {"recovered", "aborted-no-write"}
        else:
            return
        invalid = [phase for phase in phases if phase not in allowed]
        if invalid:
            raise CutoverError(f"invalid chain: member phases {invalid!r} beneath {set_phase}")

    def resume_set(self, set_id: str) -> dict[str, Any]:
        restart: dict[str, Any] | None = None
        with self._global_lock():
            intent = self._intent(set_id)
            if intent["operation"] == "baseline-v1":
                self._validate_parent_binding(intent.get("parent_set_id") or "", set_id, intent["desired_manifest"])
            self.assert_admission_clear(set_id, intent.get("parent_set_id"))
            set_journal = self._set_journal(intent)
            phase = set_journal.last_phase()
            if phase is None:
                with self._member_locks(intent["members"]):
                    restart = self._restart_prejournal(intent)
            else:
                if phase not in {"set-initializing", "set-prepared", "set-applying", "set-committed", "set-recovered"}:
                    raise CutoverError(f"set cannot resume from {phase}")
                with self._member_locks(intent["members"]):
                    self._validate_set_member_matrix(intent, phase)
                    if phase in {"set-committed", "set-recovered"}:
                        manifest = intent["desired_manifest"] if phase == "set-committed" else intent["expected_manifest"]
                        for member in intent["members"]:
                            metadata = self._verify_member_identity_and_probe(intent, member)
                            verify_manifest(Path(member["target"]), manifest, metadata.st_uid, metadata.st_gid)
                            if snapshot_unrelated_siblings(Path(member["target"]), intent["identities"]) != member["sentinel"]:
                                raise CutoverError(f"committed member drift during resume: {member['target']}")
                        return {"set_id": set_id, "phase": phase}
                    if intent["operation"] == "cutover-v1":
                        for member in intent["members"]:
                            self._restore_cutover_member(intent, member)
                        set_journal.append("set-recovered", {"expected_digest": intent["expected_manifest"]["owned_tree_sha256"]})
                        return {"set_id": set_id, "phase": "set-recovered"}
                    if phase == "set-initializing":
                        for member in intent["members"]:
                            workspace = Path(member["workspace"])
                            workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
                            member_journal = self._member_journal(intent, member)
                            member_phase = member_journal.last_phase()
                            if member_phase is None:
                                member_journal.append("initializing", {})
                                member_phase = "initializing"
                            if member_phase == "initializing":
                                self._prepare_member(intent, member, None)
                        set_journal.append("set-prepared", {"member_count": len(intent["members"])})
                        phase = "set-prepared"
                    if phase == "set-prepared":
                        set_journal.append("set-applying", {"member_count": len(intent["members"])})
                    for member in intent["members"]:
                        self._resume_baseline_member(intent, member)
                    set_journal.append("set-committed", {"desired_digest": intent["desired_manifest"]["owned_tree_sha256"]})
                    return {"set_id": set_id, "phase": "set-committed"}
        if restart is not None:
            return self.start_set(**restart)
        raise CutoverError("unreachable resume state")

    def validate_set(self, set_id: str) -> dict[str, Any]:
        with self._global_lock():
            intent = self._intent(set_id)
            with self._member_locks(intent["members"]):
                journal = self._set_journal(intent)
                if journal.last_phase() != "set-committed":
                    raise CutoverError("validation requires set-committed")
                self._validate_set_member_matrix(intent, "set-committed")
                for member in intent["members"]:
                    target = Path(member["target"])
                    metadata = self._verify_member_identity_and_probe(intent, member)
                    verify_manifest(target, intent["desired_manifest"], metadata.st_uid, metadata.st_gid)
                    if snapshot_unrelated_siblings(target, intent["identities"]) != member["sentinel"]:
                        raise CutoverError(f"unrelated sibling drift during validation: {target}")
                phase = "post-validation-passed" if intent["operation"] == "cutover-v1" else "rollback-validation-passed"
                receipt = bind_receipt(
                    {
                        "schema_version": SCHEMA_VERSION,
                        "set_id": set_id,
                        "operation": intent["operation"],
                        "phase": phase,
                        "desired_digest": intent["desired_manifest"]["owned_tree_sha256"],
                        "checked_members": [member["member_id"] for member in intent["members"]],
                    }
                )
                journal.append(phase, receipt)
                return {"set_id": set_id, "phase": phase, "receipt_sha256": receipt["receipt_sha256"]}

    def cleanup_set(self, set_id: str) -> dict[str, Any]:
        with self._global_lock():
            intent = self._intent(set_id)
            with self._member_locks(intent["members"]):
                journal = self._set_journal(intent)
                records = journal.read_all()
                phase = records[-1]["phase"] if records else None
                allowed = {
                    "set-recovered": "cleanup-complete",
                    "post-validation-passed": "cleanup-complete",
                    "rollback-validation-passed": "rollback-cleanup-complete",
                }
                removed: list[str] = []
                if phase == "cleanup-failed":
                    failure = records[-1]["data"]
                    verify_receipt(
                        failure,
                        {
                            "schema_version": SCHEMA_VERSION,
                            "set_id": set_id,
                            "operation": intent["operation"],
                            "terminal_phase": "cleanup-failed",
                            "retained_records": True,
                        },
                    )
                    terminal = failure.get("intended_terminal_phase")
                    if terminal not in {"cleanup-complete", "rollback-cleanup-complete"}:
                        raise CutoverError("cleanup failure receipt has invalid intended terminal")
                    removed = list(failure.get("removed_workspaces", []))
                else:
                    if phase not in allowed:
                        raise CutoverError(f"cleanup is not allowed from {phase}")
                    terminal = allowed[phase]
                member_phases = [self._member_journal(intent, member).last_phase() for member in intent["members"]]
                if all(member_phase == "committed" for member_phase in member_phases):
                    self._validate_set_member_matrix(intent, "set-committed")
                elif all(member_phase in {"recovered", "aborted-no-write"} for member_phase in member_phases):
                    self._validate_set_member_matrix(intent, "set-recovered")
                else:
                    raise CutoverError(f"cleanup member phase mismatch: {member_phases!r}")
                try:
                    for member in intent["members"]:
                        workspace = Path(member["workspace"])
                        if not workspace.exists():
                            raise CutoverError(f"member history workspace missing during cleanup: {workspace}")
                        for child in sorted(workspace.iterdir(), key=lambda item: os.fsencode(item.name)):
                            if child.name == "records":
                                continue
                            _remove_path(child)
                            path_label = str(child)
                            if path_label not in removed:
                                removed.append(path_label)
                        fsync_directory(workspace)
                except (OSError, CutoverError) as error:
                    receipt = bind_receipt(
                        {
                            "schema_version": SCHEMA_VERSION,
                            "set_id": set_id,
                            "operation": intent["operation"],
                            "terminal_phase": "cleanup-failed",
                            "intended_terminal_phase": terminal,
                            "removed_workspaces": removed,
                            "retained_records": True,
                            "error": f"{type(error).__name__}: {error}",
                        }
                    )
                    journal.append("cleanup-failed", receipt)
                    raise CutoverError(f"cleanup failed for {set_id}: {error}") from error
                receipt = bind_receipt(
                    {
                        "schema_version": SCHEMA_VERSION,
                        "set_id": set_id,
                        "operation": intent["operation"],
                        "terminal_phase": terminal,
                        "removed_workspaces": removed,
                        "retained_records": True,
                    }
                )
                journal.append(terminal, receipt)
                return {"set_id": set_id, "phase": terminal, "receipt_sha256": receipt["receipt_sha256"]}




def materialize_manifest(
    source_root: Path,
    destination_root: Path,
    manifest: dict[str, Any],
    target_uid: int,
    target_gid: int,
) -> dict[str, Any]:
    source_root = source_root.resolve(strict=True)
    validate_manifest_integrity(manifest, manifest["identities"])
    if destination_root.exists():
        if destination_root.is_symlink() or any(destination_root.iterdir()):
            raise CutoverError(f"materialization destination must be an empty directory: {destination_root}")
    else:
        destination_root.mkdir(parents=True, mode=0o700)
    root_fd = os.open(destination_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fchown(root_fd, target_uid, target_gid)
        os.fchmod(root_fd, 0o700)
        os.fsync(root_fd)
    finally:
        os.close(root_fd)
    entries = manifest["entries"]
    directories = [entry for entry in entries if entry["type"] == "directory"]
    leaves = [entry for entry in entries if entry["type"] != "directory"]
    for entry in sorted(directories, key=lambda item: (item["path"].count("/"), _relative_bytes(item["path"]))):
        destination = destination_root / entry["path"]
        destination.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fchown(descriptor, target_uid, target_gid)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    for entry in sorted(leaves, key=lambda item: _relative_bytes(item["path"])):
        source = source_root / entry["path"]
        if not source.exists() and not source.is_symlink():
            raise CutoverError(f"manifest payload missing from source checkout: {entry['path']}")
        _copy_entry(source, destination_root / entry["path"], target_uid, target_gid)
    for entry in sorted(directories, key=lambda item: (-item["path"].count("/"), _relative_bytes(item["path"]))):
        destination = destination_root / entry["path"]
        descriptor = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fchmod(descriptor, int(entry["mode"], 8))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        fsync_directory(destination.parent)
    fsync_directory(destination_root)
    return verify_manifest(destination_root, manifest, target_uid, target_gid)

def preflight_targets(
    targets: list[Path],
    identities: list[str],
    state_root: Path,
) -> dict[str, Any]:
    members = canonicalize_targets(targets)
    effective = {
        "uid": os.geteuid(),
        "gid": os.getegid(),
        "supplementary_groups": sorted(os.getgroups()),
    }
    expected_digest: str | None = None
    absence: list[str] | None = None
    evidence_members: list[dict[str, Any]] = []
    for member in members:
        target = Path(member["target"])
        metadata = os.stat(target, follow_symlinks=False)
        if metadata.st_uid != effective["uid"]:
            raise CutoverError(f"unexpected target owner for {target}: {metadata.st_uid}")
        if metadata.st_gid not in {effective["gid"], *effective["supplementary_groups"]}:
            raise CutoverError(f"target group is not in effective supplementary groups: {target}")
        if metadata.st_mode & 0o022:
            raise CutoverError(f"group/world-writable target root is forbidden: {target}")
        manifest = scan_manifest(target, identities, metadata.st_uid, metadata.st_gid)
        member_absence = [identity for identity in sorted(identities, key=_relative_bytes) if not (target / identity).exists() and not (target / identity).is_symlink()]
        if expected_digest is None:
            expected_digest = manifest["owned_tree_sha256"]
            absence = member_absence
        elif manifest["owned_tree_sha256"] != expected_digest or member_absence != absence:
            raise CutoverError("active targets have divergent migration-owned manifests or absence sets")
        capability = capability_probe(target, state_root / "capability" / _member_id(member))
        sentinel = snapshot_unrelated_siblings(target, identities)
        sentinel_sha256 = sha256_bytes(canonical_bytes(sentinel))
        evidence_members.append(
            {
                **member,
                "root_mode": stat.S_IMODE(metadata.st_mode),
                "manifest_digest": manifest["owned_tree_sha256"],
                "absence": member_absence,
                "sentinel_sha256": sentinel_sha256,
                "sentinel": sentinel,
                "capability_evidence_sha256": capability["evidence_sha256"],
                "capability": capability,
            }
        )
    unsigned = {
        "schema_version": SCHEMA_VERSION,
        "effective_identity": effective,
        "identities": sorted(identities, key=_relative_bytes),
        "owned_tree_sha256": expected_digest,
        "absence": absence,
        "members": evidence_members,
        "captured_at_ns": time.time_ns(),
    }
    return {**unsigned, "preflight_sha256": sha256_bytes(canonical_bytes(unsigned))}

def import_baseline(
    source_root: Path,
    output_root: Path,
    identities: list[str],
    fork_revision: str,
    preflight: dict[str, Any],
    receipt_output: Path,
) -> dict[str, Any]:
    source_root = source_root.resolve(strict=True)
    source_metadata = os.stat(source_root, follow_symlinks=False)
    source_manifest = scan_manifest(source_root, identities, source_metadata.st_uid, source_metadata.st_gid)
    digest = source_manifest["owned_tree_sha256"]
    matching_members = [member for member in preflight.get("members", []) if member.get("target") == str(source_root)]
    if len(matching_members) != 1 or preflight.get("owned_tree_sha256") != digest:
        raise CutoverError("baseline source is not bound to the accepted two-alias preflight")
    claimed_preflight = preflight.get("preflight_sha256")
    unsigned_preflight = dict(preflight)
    unsigned_preflight.pop("preflight_sha256", None)
    if claimed_preflight != sha256_bytes(canonical_bytes(unsigned_preflight)):
        raise CutoverError("preflight evidence digest mismatch")
    destination = output_root / digest
    if destination.exists():
        provenance = load_json(destination / "baseline-source.json")
        if provenance.get("owned_tree_sha256") != digest or provenance.get("fork_revision") != fork_revision:
            raise CutoverError(f"existing baseline provenance mismatch: {destination}")
        skills_root = destination / "skills"
        verify_manifest(skills_root, source_manifest, skills_root.stat().st_uid, skills_root.stat().st_gid)
        receipt = bind_receipt(
            {
                "schema_version": SCHEMA_VERSION,
                "source_root": str(source_root),
                "preflight_sha256": claimed_preflight,
                "baseline_digest": digest,
                "fork_revision": fork_revision,
                "destination": str(destination.resolve()),
            }
        )
        atomic_json(receipt_output, receipt)
        return provenance
    output_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = output_root / f".import-{os.getpid()}-{time.time_ns()}"
    skills_root = temporary / "skills"
    skills_root.mkdir(parents=True, mode=0o700)
    try:
        for identity in sorted(identities, key=_relative_bytes):
            _copy_identity(source_root, skills_root, identity, source_metadata.st_uid, source_metadata.st_gid)
        imported_manifest = scan_manifest(skills_root, identities, source_metadata.st_uid, source_metadata.st_gid)
        if imported_manifest != source_manifest:
            raise CutoverError("baseline import does not reproduce the source manifest")
        provenance = {
            "schema_version": SCHEMA_VERSION,
            "source_kind": "active-predecessor",
            "fork_revision": fork_revision,
            "identities": sorted(identities, key=_relative_bytes),
            "owned_tree_sha256": digest,
            "manifest": source_manifest,
        }
        atomic_json(temporary / "baseline-source.json", provenance)
        os.replace(temporary, destination)
        fsync_directory(output_root)
        receipt = bind_receipt(
            {
                "schema_version": SCHEMA_VERSION,
                "source_root": str(source_root),
                "preflight_sha256": claimed_preflight,
                "baseline_digest": digest,
                "fork_revision": fork_revision,
                "destination": str(destination.resolve()),
            }
        )
        atomic_json(receipt_output, receipt)
        return provenance
    except BaseException:
        _remove_path(temporary)
        raise

def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CutoverError(f"cannot load JSON {path}: {error}") from error
    if not isinstance(value, dict):
        raise CutoverError(f"JSON root must be an object: {path}")
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Scoped transactional OMP skill-set deployment")
    subparsers = parser.add_subparsers(dest="command", required=True)

    scan = subparsers.add_parser("scan")
    scan.add_argument("--root", type=Path, required=True)
    scan.add_argument("--identity", action="append", required=True)
    scan.add_argument("--output", type=Path, required=True)

    probe = subparsers.add_parser("probe")
    probe.add_argument("--target-root", type=Path, required=True)
    probe.add_argument("--state-root", type=Path, required=True)
    probe.add_argument("--output", type=Path, required=True)

    materialize = subparsers.add_parser("materialize")
    materialize.add_argument("--source-root", type=Path, required=True)
    materialize.add_argument("--destination-root", type=Path, required=True)
    materialize.add_argument("--manifest", type=Path, required=True)
    materialize.add_argument("--target-uid", type=int, required=True)
    materialize.add_argument("--target-gid", type=int, required=True)

    preflight = subparsers.add_parser("preflight")
    preflight.add_argument("--target-root", type=Path, action="append", required=True)
    preflight.add_argument("--identity", action="append", required=True)
    preflight.add_argument("--state-root", type=Path, required=True)
    preflight.add_argument("--output", type=Path, required=True)

    baseline = subparsers.add_parser("import-baseline")
    baseline.add_argument("--source-root", type=Path, required=True)
    baseline.add_argument("--output-root", type=Path, required=True)
    baseline.add_argument("--identity", action="append", required=True)
    baseline.add_argument("--fork-revision", required=True)
    baseline.add_argument("--preflight-evidence", type=Path, required=True)
    baseline.add_argument("--receipt-output", type=Path, required=True)

    start = subparsers.add_parser("start")
    start.add_argument("--operation", choices=("cutover-v1", "baseline-v1"), required=True)
    start.add_argument("--source-root", type=Path, required=True)
    start.add_argument("--target-root", type=Path, action="append", required=True)
    start.add_argument("--identity", action="append", required=True)
    start.add_argument("--expected-manifest", type=Path, required=True)
    start.add_argument("--desired-manifest", type=Path, required=True)
    start.add_argument("--state-root", type=Path, required=True)
    start.add_argument("--parent-set-id")

    member = subparsers.add_parser("member")
    mode = member.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--prepare", action="store_true")
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--recover", action="store_true")
    member.add_argument("--state-root", type=Path, required=True)
    member.add_argument("--set-id", required=True)
    member.add_argument("--source-root", type=Path, required=True)
    member.add_argument("--target-root", type=Path, required=True)
    member.add_argument("--manifest", type=Path, required=True)
    member.add_argument("--expected-target-state", type=Path, required=True)
    member.add_argument("--set-journal", type=Path, required=True)

    failure = subparsers.add_parser("record-validation-failure")
    failure.add_argument("--state-root", type=Path, required=True)
    failure.add_argument("--parent-set-id", required=True)
    failure.add_argument("--baseline-source-root", type=Path, required=True)
    failure.add_argument("--target-root", type=Path, action="append", required=True)
    failure.add_argument("--identity", action="append", required=True)
    failure.add_argument("--baseline-manifest", type=Path, required=True)

    for command in ("resume", "validate", "cleanup"):
        child = subparsers.add_parser(command)
        child.add_argument("--state-root", type=Path, required=True)
        child.add_argument("--set-id", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    if arguments.command == "scan":
        metadata = os.stat(arguments.root.resolve(strict=True), follow_symlinks=False)
        manifest = scan_manifest(arguments.root, arguments.identity, metadata.st_uid, metadata.st_gid)
        atomic_json(arguments.output, manifest, 0o644)
        print(json.dumps({"manifest": str(arguments.output), "sha256": manifest["owned_tree_sha256"]}))
        return 0
    if arguments.command == "probe":
        evidence = capability_probe(arguments.target_root, arguments.state_root)
        atomic_json(arguments.output, evidence)
        print(json.dumps(evidence, sort_keys=True))
        return 0
    if arguments.command == "materialize":
        manifest = load_json(arguments.manifest)
        observed = materialize_manifest(
            arguments.source_root,
            arguments.destination_root,
            manifest,
            arguments.target_uid,
            arguments.target_gid,
        )
        print(json.dumps({"owned_tree_sha256": observed["owned_tree_sha256"]}, sort_keys=True))
        return 0
    if arguments.command == "preflight":
        evidence = preflight_targets(arguments.target_root, arguments.identity, arguments.state_root)
        atomic_json(arguments.output, evidence)
        print(json.dumps({"preflight_sha256": evidence["preflight_sha256"], "distinct_members": len(evidence["members"])}, sort_keys=True))
        return 0
    if arguments.command == "import-baseline":
        provenance = import_baseline(
            arguments.source_root,
            arguments.output_root,
            arguments.identity,
            arguments.fork_revision,
            load_json(arguments.preflight_evidence),
            arguments.receipt_output,
        )
        print(json.dumps({"baseline_digest": provenance["owned_tree_sha256"]}, sort_keys=True))
        return 0
    coordinator = DeploymentCoordinator(arguments.state_root)
    if arguments.command == "member":
        selected_mode = next(name for name in ("check", "prepare", "apply", "recover") if getattr(arguments, name))
        result = coordinator.run_member_mode(
            selected_mode,
            arguments.set_id,
            arguments.source_root,
            arguments.target_root,
            load_json(arguments.manifest),
            load_json(arguments.expected_target_state),
            arguments.set_journal,
        )
    elif arguments.command == "start":
        result = coordinator.start_set(
            arguments.operation,
            arguments.source_root,
            arguments.target_root,
            arguments.identity,
            load_json(arguments.expected_manifest),
            load_json(arguments.desired_manifest),
            arguments.parent_set_id,
        )
    elif arguments.command == "record-validation-failure":
        child_id = coordinator.record_validation_failure(
            arguments.parent_set_id,
            arguments.baseline_source_root,
            arguments.target_root,
            arguments.identity,
            load_json(arguments.baseline_manifest),
        )
        result = {"parent_set_id": arguments.parent_set_id, "child_set_id": child_id, "phase": "post-validation-failed"}
    elif arguments.command == "resume":
        result = coordinator.resume_set(arguments.set_id)
    elif arguments.command == "validate":
        result = coordinator.validate_set(arguments.set_id)
    else:
        result = coordinator.cleanup_set(arguments.set_id)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CutoverError as error:
        print(json.dumps({"error": str(error)}, sort_keys=True), file=os.sys.stderr)
        raise SystemExit(2)
