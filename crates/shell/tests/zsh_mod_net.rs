//! zsh/net/socket and zsh/net/tcp over real sockets, through the obash
//! binary run as `zsh -f -c SCRIPT` in a fresh temporary directory: a
//! Unix-domain listen/accept/connect round trip and a TCP loopback round
//! trip with `ztcp -L` and `ztcp` listings. TCP output is compared against
//! a complete expected listing with reverse names obtained independently
//! from the operating system.

#![cfg(unix)]

mod obash_support;

use std::{os::unix::process::CommandExt, process::Command};

use crate::obash_support::{obash, output};

/// Independently resolve an IPv4 address to its required reverse name, or its
/// numeric spelling when the operating system has no reverse name.
fn reverse_name_or_numeric(addr: std::net::Ipv4Addr) -> String {
	use std::{ffi::CStr, mem::size_of};

	// SAFETY: an all-zero sockaddr_in is a valid starting representation; all
	// fields used by getnameinfo are initialized below.
	let mut sockaddr: libc::sockaddr_in = unsafe { std::mem::zeroed() };
	sockaddr.sin_family = libc::AF_INET as libc::sa_family_t;
	sockaddr.sin_addr = libc::in_addr { s_addr: u32::from_ne_bytes(addr.octets()) };
	#[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
	{
		sockaddr.sin_len = size_of::<libc::sockaddr_in>() as u8;
	}

	let mut host = [0 as libc::c_char; libc::NI_MAXHOST as usize];
	// SAFETY: sockaddr is initialized with a valid IPv4 address and the correct
	// platform-specific length; host is writable for its full declared size.
	let status = unsafe {
		libc::getnameinfo(
			(&sockaddr as *const libc::sockaddr_in).cast(),
			size_of::<libc::sockaddr_in>() as libc::socklen_t,
			host.as_mut_ptr(),
			host.len() as libc::socklen_t,
			std::ptr::null_mut(),
			0,
			libc::NI_NAMEREQD,
		)
	};
	if status == 0 {
		// SAFETY: status 0 guarantees a NUL-terminated hostname in host's buffer.
		unsafe { CStr::from_ptr(host.as_ptr()) }
			.to_str()
			.expect("OS reverse hostname is not UTF-8")
			.to_owned()
	} else {
		addr.to_string()
	}
}

/// Run `script` as `zsh -f -c script` in a new empty directory with
/// `$PORT` set: stdout, stderr, status.
fn run(mut cmd: Command, script: &str, port: u16) -> (String, String, i32) {
	let dir = tempfile::tempdir().unwrap();
	cmd.arg0("zsh");
	let out = output(
		cmd.current_dir(dir.path())
			.env("PORT", port.to_string())
			.args(["-f", "-c", script]),
	);
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
		out.status.code().unwrap_or(-1),
	)
}

/// A TCP port nothing listens on right now.
fn free_port() -> u16 {
	let l = std::net::TcpListener::bind(("0.0.0.0", 0)).unwrap();
	l.local_addr().unwrap().port()
}

#[test]
fn zsh_mod_net_unix_socket_round_trip() {
	let (out, err, st) = run(
		obash(),
		"zmodload zsh/net/socket
zsocket -l sock; l=$REPLY; (( l >= 10 )) && echo listener
zsocket -a -t $l; echo t=$?
( zsocket sock; print -u $REPLY hello )
zsocket -v -a -t $l; a=$REPLY
read -u $a line; echo got $line
zsocket -v sock2; echo $?
zsocket -l sock; echo $?
exec {l}>&-; rm sock",
		0,
	);
	assert_eq!(out, "listener\nt=1\nnew connection from  is on fd 3\ngot hello\n1\n1\n");
	assert_eq!(
		err,
		"zsh:zsocket:7: connection failed: no such file or directory
zsh:zsocket:8: could not bind to sock: address already in use
"
	);
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_net_tcp_loopback_round_trip() {
	let port = free_port();
	let script = r#"zmodload zsh/net/tcp
ztcp -l $PORT; l=$REPLY
ztcp -L | while read fd rest; do print -r -- $rest; done
ztcp 127.0.0.1 $PORT; o=$REPLY
ztcp -a $l; i=$REPLY
ztcp -L | while read fd t la lp ra rp; do print -r -- $t $la $lp $ra ${${t:#I}:+$rp}; done
ztcp | while read l1 dir r rest; do print -r -- ${l1%:<->}  $dir ${r%:<->}; done
print -u $o hi; read -u $i x; echo $x
print -u $i back; read -u $o y; echo $y
x=$(ztcp -v 127.0.0.1 $PORT); print -r -- ${x%% is now*}
ztcp -c $o; n=(${(f)"$(ztcp -L)"}); echo $#n
ztcp -c; n=(${(f)"$(ztcp -L)"}); echo $#n
ztcp 127.0.0.1 $PORT; echo $?
ztcp localhost $PORT; echo $?"#;
	let (out, err, st) = run(obash(), script, port);
	let addr = reverse_name_or_numeric(std::net::Ipv4Addr::UNSPECIFIED);
	let loopback = reverse_name_or_numeric(std::net::Ipv4Addr::LOCALHOST);
	let expected = format!(
		concat!(
			"L {addr} {port} {addr} 0\n",
			"L {addr} {port} {addr} 0\n",
			"O {addr} 0 {loopback} {port}\n",
			"I {addr} 0 {loopback}\n",
			"{addr} -< {addr}\n",
			"{addr} -> {loopback}\n",
			"{addr} <- {loopback}\n",
			"hi\nback\n127.0.0.1:{}\n2\n0\n1\n1\n",
		),
		i32::from(port.to_be()),
		addr = addr,
		port = port,
		loopback = loopback,
	);
	assert_eq!(out, expected);
	assert_eq!(st, 0);
	let expected_err = "zsh:ztcp:13: connection failed: connection refused
zsh:ztcp:14: connection failed: connection refused
";
	assert_eq!(err, expected_err);
}
