# Upgrading

## What happens when you upgrade

Install the new version and start it. Nothing else is needed: OpenClerq brings its database
(`~/.clerq/clerq.db`; `%USERPROFILE%\.clerq\clerq.db` on Windows) up to date itself.

If the database was written by an older version, OpenClerq first writes a copy, then migrates:

- The copy is `~/.clerq/backups/clerq-schema<N>-<UTC time>.db`, where `<N>` is the schema the
  database was at. It is a single file (mode 0600, in a folder of mode 0700 on macOS and Linux),
  made with SQLite's `VACUUM INTO`, so it is consistent even if the database was in use.
- The newest five copies are kept; older ones are deleted. Files in that folder that OpenClerq did
  not make are left alone.
- If the copy cannot be made (no room on the disk, a folder that cannot be written), nothing is
  migrated and OpenClerq does not start. It says why, in words, and changes nothing.
- A copy holds everything the database does (conversations, run prompts, memory), so keep it as
  private as the database; delete the files in `backups/` if you do not want them.
- A new database has nothing to copy, and none is made.
- Only one OpenClerq upgrades a database at a time. A second one started meanwhile (another window,
  a gateway run from a terminal) waits for the first, up to two minutes, finds nothing left to do and
  carries on without a copy of its own. If the first has not finished by then, the second stops and
  names the lock file, `clerq.db.upgrade-lock`; delete it only when no OpenClerq is running. A lock
  left by a process that is gone, or older than a quarter of an hour, is taken over.
- The log says which migrations ran and where the copy is (`Store upgraded`). The desktop app
  passes the background service's output on to its own stderr (see
  [SECURITY.md](SECURITY.md#2-what-is-protected-today)), so a refusal to start shows there when the app is
  started from a terminal.

## Downgrades are refused

An older OpenClerq cannot know what a newer one changed in the database, so it will not open one:

> This database was written by a newer OpenClerq (schema 23); this build knows schema 21. Install
> the newer version, or restore a backup from ~/.clerq/backups.

The background service stops with that message instead of starting half-working; the desktop app
then shows that the service is not responding. Either install the newer version again, or go back
to the older one properly by restoring a copy:

1. Quit OpenClerq: the desktop app, and any `clerq-gateway` or `pnpm gateway` still running.
2. In `~/.clerq`, move these three files somewhere else (do not delete them yet): `clerq.db`,
   `clerq.db-wal`, `clerq.db-shm`. Move all of them. A leftover `-wal` file from the newer database
   would be replayed over the copy and damage it.
3. Copy a backup from `~/.clerq/backups/` to `~/.clerq/clerq.db`. The number in a backup's name
   (`clerq-schema12-…` is a database at schema 12) must not be higher than the one in the message
   ("this build knows schema 21"), since the older version refuses a newer database whether it came
   from a backup or not; take the newest one that fits. It holds everything up to the moment of the
   upgrade and nothing after it. Copy only the `.db` file.
4. Start the older version. Once you are sure of the result, delete the files you moved away.

## The API version

Clients and gateways agree on an API version, one whole number, sent as `Clerq-Api-Version` and
as the `/v1` in every address. Within a version nothing is removed or changed, so an app and a
gateway of different releases keep working together; a version that cannot be served is refused
in words. See [API.md](API.md).

## The automation spec version

An automation file may say `version: 1` at the top; leaving it out means the same. A file written
for a version this OpenClerq does not read is refused when it is saved, previewed or read, naming
the line: "This automation was written for spec version 2; this OpenClerq reads version 1." A later
version that changes the format will translate version 1 files when it reads them. Stored specs are
never rewritten for you.

## Module migrations

A module may ship SQL migrations (`migrations/NNNN_name.sql`) for its own tables, `mod_<id>__*`.
They run when the module loads, each once, and are recorded with a checksum. A migration that was
edited after it ran is refused, and so is a module whose data was written by a newer copy of it
(one that ships fewer migrations than the database has applied): that module is listed as failed
at `GET /modules`, with the reason, and the gateway and the other modules carry on. Install the
newer version of the module. The copy made before an upgrade is of the whole database, module
tables included, but it is made only when core migrations are pending; a module's migration alone
does not make one, so copy `clerq.db` yourself before updating a module whose data you cannot lose.
