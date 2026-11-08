//! Read-through file access for engines.
//!
//! [`FileSource`] resolves authored paths through [`PathPolicy`], recovers
//! missing paths by unique suffix, enforces the auto-generated guard, decodes
//! notebooks to their editable text, and caches reads by `(path, mtime, len)`
//! for the lifetime of one preview/apply pass. Engines never touch
//! `std::fs` directly; the session clears the cache before `apply` so a final
//! stage always sees fresh bytes.
//!
//! [`FileCache`] also owns the host's answers. A URL target missing from the
//! URL table is recorded (see [`FileCache::take_unresolved`]) and fails with
//! [`EditError::UnresolvedUrl`] until the host [`FileCache::provide`]s it. A
//! must-exist path that is missing on disk is recorded the same way (see
//! [`FileCache::take_recovery_misses`]) and resolves as not recovered until
//! the host searches the working tree and [`FileCache::provide_recovery`]s
//! the answer: the engine itself never walks.
//!
//! A cache built [`FileCache::with_source_snapshots`] is closed-world: it
//! reads only the bytes the host captured when the call was approved, keyed
//! by each target's physical path, and never the disk. A target whose path
//! now lands elsewhere (a swapped symlink, a recovered or re-resolved path)
//! is refused instead of read.

use std::{
	collections::HashMap,
	fs::FileType,
	path::{Path, PathBuf},
	sync::Arc,
	time::SystemTime,
};

use crate::{
	engine::{FileOp, Resolved},
	error::{EditError, EditResult, Rejection},
	notebook,
	path_policy::{PathPolicy, RecoveryGlob, UrlResolution, canonical_key, physical_path},
	text::{LineEnding, detect_line_ending, normalize_to_lf, restore_line_endings, strip_bom},
};

/// One target file as read from disk plus its normalized editable form.
#[derive(Debug)]
pub struct FileRead {
	pub resolved:    Resolved,
	/// Snapshot-store key.
	pub canonical:   PathBuf,
	/// Bytes as read (notebook JSON for `.ipynb`).
	pub raw:         String,
	pub bom:         &'static str,
	pub ending:      LineEnding,
	/// LF-normalized, BOM-stripped editable text (notebook cell projection).
	pub text:        String,
	pub is_notebook: bool,
}

impl FileRead {
	/// Encode LF-normalized post-edit text back to the bytes this file
	/// persists with: BOM and line endings restored, notebooks re-serialized.
	pub fn persist(&self, after_lf: &str) -> EditResult<String> {
		if self.is_notebook {
			return notebook::serialize_edited_notebook_text(
				Some(&self.raw),
				after_lf,
				&self.resolved.display,
			)
			.map_err(|err| EditError::apply(err.to_string()));
		}
		let mut out = String::with_capacity(self.bom.len() + after_lf.len());
		out.push_str(self.bom);
		out.push_str(&restore_line_endings(after_lf, self.ending));
		Ok(out)
	}
}

/// Persist text for a file that did not exist before the edit.
pub fn persist_new(resolved: &Resolved, after_lf: &str) -> EditResult<String> {
	if notebook::is_notebook_path(&resolved.absolute) {
		return notebook::serialize_edited_notebook_text(None, after_lf, &resolved.display)
			.map_err(|err| EditError::apply(err.to_string()));
	}
	Ok(after_lf.to_owned())
}

/// Source bytes the host captured for each edit target when the call was
/// approved, keyed by physical path ([`physical_path`]); `None` marks a target
/// that did not exist then.
pub type SourceSnapshots = HashMap<PathBuf, Option<Vec<u8>>>;

/// Filesystem view an engine reads through.
pub trait FileSource {
	fn policy(&self) -> &PathPolicy;

	/// Resolve an authored path without reading it. When `must_exist` and
	/// the resolved file is missing, the host's unique-suffix recovery answer
	/// may substitute a different display/absolute pair (never for internal
	/// URLs, which fail with [`EditError::UnresolvedUrl`] until the host
	/// answers them).
	fn resolve(&mut self, authored: &str, must_exist: bool) -> EditResult<Resolved>;

	/// Whether `absolute` currently exists (file or directory).
	fn exists(&mut self, absolute: &Path) -> bool;

	/// Read a target that must exist. Fails with `File not found: <display>`
	/// after recovery, or with the auto-generated guard message.
	fn read(&mut self, authored: &str) -> EditResult<Arc<FileRead>>;

	/// Read an already-resolved target; `Ok(None)` when it does not exist.
	fn try_read(&mut self, resolved: &Resolved) -> EditResult<Option<Arc<FileRead>>>;

	/// Drop every cached read and path resolution. Host URL answers survive.
	fn clear(&mut self);
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Stamp {
	mtime:        Option<SystemTime>,
	len:          u64,
	special_kind: Option<&'static str>,
}

/// Kind of a non-regular, non-directory file, or `None`. Reading one can block
/// forever (a FIFO, a terminal) or never end (`/dev/zero`). `metadata` follows
/// symlinks, so a link reports its target's kind.
fn special_file_kind(file_type: FileType) -> Option<&'static str> {
	if file_type.is_file() || file_type.is_dir() {
		return None;
	}
	#[cfg(unix)]
	{
		use std::os::unix::fs::FileTypeExt;
		if file_type.is_char_device() {
			return Some("character device");
		}
		if file_type.is_block_device() {
			return Some("block device");
		}
		if file_type.is_fifo() {
			return Some("FIFO");
		}
		if file_type.is_socket() {
			return Some("socket");
		}
	}
	Some("special file")
}

fn stamp(absolute: &Path) -> Option<Stamp> {
	let meta = std::fs::metadata(absolute).ok()?;
	Some(Stamp {
		mtime:        meta.modified().ok(),
		len:          meta.len(),
		special_kind: special_file_kind(meta.file_type()),
	})
}

/// Default [`FileSource`] backed by `std::fs`.
pub struct FileCache {
	policy:          PathPolicy,
	/// Cached reads; the stamp is `None` for reads from `snapshots`.
	reads:           HashMap<PathBuf, (Option<Stamp>, Arc<FileRead>)>,
	/// Authored path → resolution (so paired hunks share one recovery).
	resolutions:     HashMap<(String, bool), Resolved>,
	/// Host answers keyed by [`PathPolicy::url_target`].
	urls:            HashMap<String, UrlResolution>,
	/// URLs that missed `urls`, deduped in first-seen order.
	unresolved:      Vec<String>,
	/// Host recovery answers keyed by authored path; `None` is "no unique
	/// match".
	recovered:       HashMap<String, Option<Resolved>>,
	/// Authored paths that missed `recovered`, deduped in first-seen order.
	recovery_misses: Vec<String>,
	/// Closed-world sources; when set, the disk is never read.
	snapshots:       Option<Arc<SourceSnapshots>>,
}

impl FileCache {
	/// Empty cache over `policy`.
	pub fn new(policy: PathPolicy) -> Self {
		Self {
			policy,
			reads: HashMap::new(),
			resolutions: HashMap::new(),
			urls: HashMap::new(),
			unresolved: Vec::new(),
			recovered: HashMap::new(),
			recovery_misses: Vec::new(),
			snapshots: None,
		}
	}

	/// Closed-world cache over `snapshots`: reads, existence checks and
	/// resolution never touch the disk, and missing paths are never
	/// recovered.
	pub fn with_source_snapshots(policy: PathPolicy, snapshots: Arc<SourceSnapshots>) -> Self {
		Self { snapshots: Some(snapshots), ..Self::new(policy) }
	}

	/// The physical path of `resolved` and the source captured there (`None`
	/// when it did not exist at approval).
	///
	/// # Errors
	/// When nothing was captured there: the path now lands somewhere the
	/// approval did not cover.
	fn snapshot_at<'a>(
		snapshots: &'a SourceSnapshots,
		resolved: &Resolved,
	) -> EditResult<(PathBuf, Option<&'a [u8]>)> {
		physical_path(&resolved.absolute)
			.and_then(|physical| {
				let source = snapshots.get(&physical)?.as_deref();
				Some((physical, source))
			})
			.ok_or_else(|| {
				EditError::apply(format!(
					"{}: the file changed after it was approved, or is not one the approval covered; \
					 the edit was refused.",
					resolved.display
				))
			})
	}

	/// Record the host answer for `url`, dropping cached resolutions and
	/// reads made for it.
	pub fn provide(&mut self, url: String, resolution: UrlResolution) {
		let policy = &self.policy;
		let names_url = |authored: &str| policy.url_target(authored).as_deref() == Some(url.as_str());
		self
			.resolutions
			.retain(|(authored, _), _| !names_url(authored));
		self
			.reads
			.retain(|_, (_, read)| !names_url(&read.resolved.display));
		self.unresolved.retain(|missed| *missed != url);
		self.urls.insert(url, resolution);
	}

	/// Drain URLs that missed the resolution table since the last call
	/// (deduped, first-seen order).
	pub fn take_unresolved(&mut self) -> Vec<String> {
		std::mem::take(&mut self.unresolved)
	}

	/// Record the host's recovery answer for the missing `authored` path
	/// (`None`: no unique match), dropping the cached resolution made without
	/// it.
	pub fn provide_recovery(&mut self, authored: String, answer: Option<Resolved>) {
		self
			.resolutions
			.retain(|(cached, _), _| *cached != authored);
		self.recovery_misses.retain(|missed| *missed != authored);
		self.recovered.insert(authored, answer);
	}

	/// Drain authored paths that missed the recovery table since the last
	/// call (deduped, first-seen order).
	pub fn take_recovery_misses(&mut self) -> Vec<String> {
		std::mem::take(&mut self.recovery_misses)
	}

	/// Drop every host answer (URL and recovery) and recorded miss, plus
	/// every cached read and resolution (some were made from those answers),
	/// so URL targets and missing paths ask the host again.
	pub fn forget_answers(&mut self) {
		self.clear();
		self.urls.clear();
		self.unresolved.clear();
		self.recovered.clear();
		self.recovery_misses.clear();
	}

	/// Plan-mode write guard, judging URL targets by their host answers.
	///
	/// # Errors
	/// [`EditError::Plan`] when plan mode refuses the write.
	pub fn enforce_write(&self, display: &str, op: FileOp, move_to: Option<&str>) -> EditResult<()> {
		self.policy.enforce_write(display, op, move_to, &self.urls)
	}

	fn read_resolved(&mut self, resolved: &Resolved) -> EditResult<Option<Arc<FileRead>>> {
		if let Some(snapshots) = self.snapshots.clone() {
			return self.read_snapshot(&snapshots, resolved);
		}
		let Some(current) = stamp(&resolved.absolute) else {
			return Ok(None);
		};
		if let Some(kind) = current.special_kind {
			return Err(EditError::apply(format!(
				"Cannot edit '{}': it is a {kind}, not a regular file or directory.",
				resolved.display
			)));
		}
		if let Some((Some(cached_stamp), read)) = self.reads.get(&resolved.absolute)
			&& *cached_stamp == current
			&& read.resolved.display == resolved.display
		{
			return Ok(Some(Arc::clone(read)));
		}
		let bytes = match std::fs::read(&resolved.absolute) {
			Ok(bytes) => bytes,
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
			Err(source) => return Err(EditError::Io { path: resolved.absolute.clone(), source }),
		};
		let read = Arc::new(self.decode(resolved, bytes, canonical_key(&resolved.absolute))?);
		self
			.reads
			.insert(resolved.absolute.clone(), (Some(current), Arc::clone(&read)));
		Ok(Some(read))
	}

	fn read_snapshot(
		&mut self,
		snapshots: &SourceSnapshots,
		resolved: &Resolved,
	) -> EditResult<Option<Arc<FileRead>>> {
		let (physical, Some(bytes)) = Self::snapshot_at(snapshots, resolved)? else {
			return Ok(None);
		};
		if let Some((None, read)) = self.reads.get(&resolved.absolute)
			&& read.resolved.display == resolved.display
		{
			return Ok(Some(Arc::clone(read)));
		}
		// A captured target existed, so its physical path is its realpath: the
		// same store key `canonical_key` gives.
		let read = Arc::new(self.decode(resolved, bytes.to_vec(), physical)?);
		self
			.reads
			.insert(resolved.absolute.clone(), (None, Arc::clone(&read)));
		Ok(Some(read))
	}

	/// Decode `bytes` read for `resolved` into its editable form, enforcing
	/// the auto-generated guard.
	fn decode(
		&self,
		resolved: &Resolved,
		bytes: Vec<u8>,
		canonical: PathBuf,
	) -> EditResult<FileRead> {
		if let Some(message) = self
			.policy
			.auto_generated_message(&resolved.display, &bytes[..bytes.len().min(1024)])
		{
			return Err(EditError::apply(message));
		}
		let raw = String::from_utf8(bytes).map_err(|err| EditError::InvalidUtf8 {
			display:     resolved.display.clone(),
			valid_up_to: err.utf8_error().valid_up_to(),
		})?;
		let is_notebook = notebook::is_notebook_path(&resolved.absolute);
		let (bom, text) = if is_notebook {
			let editable = notebook::notebook_to_editable_text(&raw, &resolved.display)
				.map_err(|err| EditError::apply(err.to_string()))?;
			("", normalize_to_lf(&editable).into_owned())
		} else {
			let (bom, body) = strip_bom(&raw);
			(bom, normalize_to_lf(body).into_owned())
		};
		let ending = if is_notebook {
			LineEnding::Lf
		} else {
			detect_line_ending(strip_bom(&raw).1)
		};
		Ok(FileRead { canonical, resolved: resolved.clone(), raw, bom, ending, text, is_notebook })
	}
}

impl FileSource for FileCache {
	fn policy(&self) -> &PathPolicy {
		&self.policy
	}

	fn resolve(&mut self, authored: &str, must_exist: bool) -> EditResult<Resolved> {
		let key = (authored.to_owned(), must_exist);
		if let Some(resolved) = self.resolutions.get(&key) {
			return Ok(resolved.clone());
		}
		let resolved = self.policy.resolve(authored, &self.urls);
		if let Err(EditError::UnresolvedUrl(url)) = &resolved
			&& !self.unresolved.contains(url)
		{
			self.unresolved.push(url.clone());
		}
		let mut resolved = resolved?;
		// Pinned sessions never substitute a path: the approval covered only
		// the authored one.
		if must_exist
			&& self.snapshots.is_none()
			&& !self.policy.is_internal_url(authored)
			&& stamp(&resolved.absolute).is_none()
		{
			match self.recovered.get(authored) {
				Some(Some(recovered)) => resolved = recovered.clone(),
				Some(None) => {},
				None => {
					// Unanswered: not cached, so the answer takes effect on the
					// rerun.
					if RecoveryGlob::new(authored).is_some()
						&& !self.recovery_misses.iter().any(|missed| missed == authored)
					{
						self.recovery_misses.push(authored.to_owned());
					}
					return Ok(resolved);
				},
			}
		}
		self.resolutions.insert(key, resolved.clone());
		Ok(resolved)
	}

	fn exists(&mut self, absolute: &Path) -> bool {
		match &self.snapshots {
			Some(snapshots) => physical_path(absolute)
				.and_then(|physical| snapshots.get(&physical))
				.is_some_and(Option::is_some),
			None => stamp(absolute).is_some(),
		}
	}

	fn read(&mut self, authored: &str) -> EditResult<Arc<FileRead>> {
		let resolved = self.resolve(authored, true)?;
		self.read_resolved(&resolved)?.ok_or_else(|| {
			EditError::rejected(
				Rejection::FileNotFound,
				format!("File not found: {}", resolved.display),
			)
		})
	}

	fn try_read(&mut self, resolved: &Resolved) -> EditResult<Option<Arc<FileRead>>> {
		self.read_resolved(resolved)
	}

	fn clear(&mut self) {
		self.reads.clear();
		self.resolutions.clear();
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn cache(root: &Path) -> FileCache {
		FileCache::new(PathPolicy {
			cwd:                  root.to_owned(),
			home_dir:             root.join("home"),
			url_schemes:          Vec::new(),
			url_alias_schemes:    Vec::new(),
			plan_writable_roots:  Vec::new(),
			plan_active:          false,
			block_auto_generated: false,
		})
	}

	#[test]
	fn missing_must_exist_path_records_one_miss_until_answered() {
		let tmp = tempfile::tempdir().unwrap();
		let mut files = cache(tmp.path());
		let unrecovered = files.resolve("src/a.ts", true).unwrap();
		assert_eq!(unrecovered.display, "src/a.ts");
		assert_eq!(unrecovered.absolute, tmp.path().join("src/a.ts"));
		files.resolve("src/a.ts", true).unwrap();
		assert_eq!(files.take_recovery_misses(), ["src/a.ts"]);
		assert!(files.take_recovery_misses().is_empty());
	}

	#[test]
	fn paths_that_need_no_recovery_record_no_miss() {
		let tmp = tempfile::tempdir().unwrap();
		std::fs::write(tmp.path().join("here.txt"), "").unwrap();
		let mut files = cache(tmp.path());
		files.resolve("here.txt", true).unwrap();
		files.resolve("new.txt", false).unwrap();
		files.resolve("./", true).unwrap();
		assert!(files.take_recovery_misses().is_empty());
	}

	#[test]
	fn recovery_answer_replaces_the_unrecovered_resolution() {
		let tmp = tempfile::tempdir().unwrap();
		let mut files = cache(tmp.path());
		files.resolve("src/a.ts", true).unwrap();
		let recovered = Resolved {
			absolute: tmp.path().join("deep/src/a.ts"),
			display:  "deep/src/a.ts".to_owned(),
		};
		files.provide_recovery("src/a.ts".to_owned(), Some(recovered.clone()));
		assert_eq!(files.resolve("src/a.ts", true).unwrap(), recovered);
		assert!(files.take_recovery_misses().is_empty());
		files.clear();
		assert_eq!(files.resolve("src/a.ts", true).unwrap(), recovered, "answers survive clear");
	}

	#[test]
	fn declined_recovery_stays_unrecovered_and_is_not_asked_again() {
		let tmp = tempfile::tempdir().unwrap();
		let mut files = cache(tmp.path());
		files.resolve("src/a.ts", true).unwrap();
		files.provide_recovery("src/a.ts".to_owned(), None);
		let resolved = files.resolve("src/a.ts", true).unwrap();
		assert_eq!(resolved.display, "src/a.ts");
		assert!(files.take_recovery_misses().is_empty());
	}

	fn snapshot_cache(root: &Path, snapshots: SourceSnapshots) -> FileCache {
		FileCache::with_source_snapshots(cache(root).policy, Arc::new(snapshots))
	}

	#[test]
	fn source_snapshots_are_read_instead_of_the_disk_and_survive_clear() {
		let tmp = tempfile::tempdir().unwrap();
		let root = tmp.path().canonicalize().unwrap();
		let source = root.join("source.rs");
		std::fs::write(&source, "disk version\n").unwrap();
		let raw = "\u{feff}snapshot\r\n";
		let mut files =
			snapshot_cache(&root, HashMap::from([(source.clone(), Some(raw.as_bytes().to_vec()))]));

		let first = files.read("source.rs").unwrap();
		assert_eq!(first.raw, raw);
		assert_eq!(first.text, "snapshot\n");
		assert_eq!(first.persist(&first.text).unwrap(), raw);
		assert_eq!(first.canonical, source);

		std::fs::write(&source, "changed on disk\n").unwrap();
		files.clear();
		assert_eq!(files.read("source.rs").unwrap().raw, raw);
	}

	#[cfg(unix)]
	#[test]
	fn a_symlink_swapped_after_capture_is_refused_not_read() {
		let tmp = tempfile::tempdir().unwrap();
		let root = tmp.path().canonicalize().unwrap();
		let allowed = root.join("allowed.rs");
		let secret = root.join("secret.rs");
		std::fs::write(&allowed, "allowed\n").unwrap();
		std::fs::write(&secret, "SECRET\n").unwrap();
		let alias = root.join("alias.rs");
		std::os::unix::fs::symlink(&allowed, &alias).unwrap();
		let mut files =
			snapshot_cache(&root, HashMap::from([(allowed.clone(), Some(b"allowed\n".to_vec()))]));
		assert_eq!(files.read("alias.rs").unwrap().text, "allowed\n");

		std::fs::remove_file(&alias).unwrap();
		std::os::unix::fs::symlink(&secret, &alias).unwrap();
		files.clear();
		let error = files.read("alias.rs").unwrap_err().to_string();
		assert!(error.contains("changed after it was approved"), "{error}");
		assert!(!error.contains("SECRET"), "{error}");
		assert!(!files.exists(&alias));
	}

	#[test]
	fn absent_and_uncaptured_targets_never_reach_the_disk() {
		let tmp = tempfile::tempdir().unwrap();
		let root = tmp.path().canonicalize().unwrap();
		let fresh = root.join("fresh.rs");
		let mut files = snapshot_cache(&root, HashMap::from([(fresh.clone(), None)]));
		std::fs::write(&fresh, "created after capture\n").unwrap();
		assert!(!files.exists(&fresh));
		let resolved = files.resolve("fresh.rs", false).unwrap();
		assert!(files.try_read(&resolved).unwrap().is_none());

		let uncaptured = root.join("nested/unique.rs");
		std::fs::create_dir_all(uncaptured.parent().unwrap()).unwrap();
		std::fs::write(&uncaptured, "not captured\n").unwrap();
		assert!(!files.exists(&uncaptured));
		assert!(files.read("nested/unique.rs").is_err());
		files.resolve("unique.rs", true).unwrap();
		assert!(files.take_recovery_misses().is_empty(), "pinned sessions never recover a path");
	}

	#[test]
	fn forgetting_answers_asks_the_host_again() {
		let tmp = tempfile::tempdir().unwrap();
		let mut files = cache(tmp.path());
		files.provide_recovery("src/a.ts".to_owned(), None);
		files.forget_answers();
		files.resolve("src/a.ts", true).unwrap();
		assert_eq!(files.take_recovery_misses(), ["src/a.ts"]);
	}
}
