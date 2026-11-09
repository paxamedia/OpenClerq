-- Tables a module owns are named mod_<id>__*, hyphens in the id as underscores.
CREATE TABLE mod_hello_world__greetings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
