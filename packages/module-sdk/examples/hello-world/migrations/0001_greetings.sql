-- Tables a module owns are named mod_<id>_*, hyphens as underscores.
CREATE TABLE mod_hello_world_greetings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
