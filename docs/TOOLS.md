# Tools in OpenClerq OSS

This document describes the **generic tools** that the OpenClerq gateway exposes to skills and modules. Tools are **role‑agnostic**: they are not tied to any specific profession or country.

---

## 1. What is a tool?

A **tool** is a function the gateway can call that:

- Has a **structured input** (JSON),
- Performs some work (e.g. read a file, call HTTP, run a local binary),
- Returns a **structured output**.

Tools are registered on the gateway and can be invoked:

- Directly over HTTP (`GET /tools`, `POST /tools/run`),
- Indirectly from skills and `/task`.

---

## 2. Built‑in tools

OpenClerq OSS ships a small, safe default set:

### 2.1 `fs.read`

- Reads a **UTF‑8 text file** from a configured root directory.
- Input:

```json
{
  "relativePath": "path/inside/root/example.txt"
}
```

- Output:

```json
{
  "path": "/absolute/path/to/path/inside/root/example.txt",
  "content": "file contents as UTF-8 string"
}
```

- Output also includes `bytes`, the file size on disk.
- Safety — the path is resolved against a `realpath`'d root (`capabilities.fsRoot`) and refused if any of the following hold:
  - it traverses out of the root (`../../etc/passwd`);
  - it lands in a sibling directory that merely shares a prefix (`/srv/repo-secrets` against a root of `/srv/repo` — this passed the pre-0.4 check);
  - it is absolute, drive-qualified, or UNC;
  - it contains a NUL byte;
  - it passes through a symlink whose target leaves the root;
  - it is not a regular file, or exceeds `capabilities.fsMaxReadBytes` (default 1 MiB), checked by `stat` before any read.

### 2.2 `http.request`

- Makes an HTTP(S) request to a **configured allow‑list** of hostnames.
- Disabled by default; enabled only when `toolsConfig.httpAllowlist` is set.
- Input:

```json
{
  "method": "GET",
  "url": "https://example.com/api",
  "headers": {
    "Accept": "application/json"
  },
  "body": "optional request body as string"
}
```

- Output:

```json
{
  "status": 200,
  "headers": {
    "content-type": "application/json; charset=utf-8"
  },
  "bodyText": "{\"ok\":true}"
}
```

Output also includes `truncated` (true when the body hit `httpMaxBytes`) and `chain`, every
URL visited including redirect hops.

Use this to call **your own APIs or services**, never arbitrary third‑party hosts.

Requests are refused when:

- the scheme is not in `httpAllowedSchemes` (default: https only);
- the host is not in `httpAllowlist` (`*.example.com` matches subdomains, not the apex);
- the URL carries credentials (`https://user:pass@host/`);
- the host resolves to a loopback, private, CGNAT, link-local, multicast or reserved address — including the cloud metadata endpoints `169.254.169.254` and `fd00:ec2::254`, and IPv4-mapped forms like `::ffff:127.0.0.1`. Override with `httpAllowPrivateAddresses` only when deliberately targeting your own network;
- the method is outside the allowed set (default: GET, HEAD, POST);
- a redirect hop fails any of the above — **every hop is revalidated**, not just the first;
- more than `maxRedirects` hops (default 3) are needed;
- the request exceeds `httpTimeoutMs` (default 10s).

Bodies over `httpMaxBytes` (default 256 KiB) are truncated rather than buffered whole.

> **Residual risk.** Addresses are checked after DNS resolution, but the connection resolves
> again, leaving a narrow DNS-rebinding window. Closing it needs a pinned-address dispatcher,
> tracked for release 0.5.

---

## 3. HTTP endpoints

The gateway exposes tools over HTTP:

- `GET /tools` — returns the list of registered tools:

```json
{
  "tools": [
    { "name": "fs.read", "description": "Read a UTF-8 file from a safe root" },
    { "name": "http.request", "description": "HTTP(S) request to an allow-listed host" }
  ]
}
```

- `POST /tools/run` — runs a specific tool:

```json
{
  "name": "fs.read",
  "input": { "relativePath": "README.md" }
}
```

Response:

```json
{
  "name": "fs.read",
  "result": {
    "path": "...",
    "content": "..."
  }
}
```

---

## 4. Extending tools

You can add your own tools by:

1. Implementing a function in the gateway that accepts `input: unknown` and returns a `Promise<unknown>`.
2. Registering it in the tool registry alongside `fs.read` and `http.request`.
3. Documenting the input/output shape so skills can call it safely.

Always:

- Restrict what the tool can access (paths, hosts, commands).
- Keep the interface small and auditable.
- Treat tools as **powerful local capabilities**: they are what makes OpenClerq an effective local MCS.

