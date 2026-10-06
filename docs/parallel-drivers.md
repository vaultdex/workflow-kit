# Parallele Driver

Beobachtungen und Verweise für mehrere Agent-Driver, die gleichzeitig auf einem
Rechner arbeiten (zuerst am 06.10.2026 in vaultdex/Vaultdex). Das Kit führt hier
keine neuen Regeln ein; verbindlich bleibt [AGENT_RULES.md](../AGENT_RULES.md).

**Ein Driver je Issue.** Jeder Driver arbeitet in einem eigenen Worktree auf der
eigenen Issue-Branch. Nur der Driver claimt und ändert den Status; Subagents
bekommen begrenzte Aufträge ([Delegation](CONTRIBUTING.md#starting-work)).

**Nachweis-Sperre.** Schwere lokale Nachweise (Backend-E2E, Playwright-Suite)
stören sich gegenseitig, sobald mehrere gleichzeitig laufen. Ein Symptom ist die
Meldung „Could not find a valid Docker environment“ ohne echten Fehler im Test.
Die Sperre dafür ist projektseitig geplant:
[vaultdex/Vaultdex#1099](https://github.com/vaultdex/Vaultdex/issues/1099).

**Flyway-Migrationsnummern.** Legen zwei Driver parallel Migrationen an, können die
Nummern kollidieren. Die Regel steht im Projekt, nicht im Kit: Vaultdex
[Flyway-Versionen](https://github.com/vaultdex/Vaultdex/blob/main/CONTRIBUTING.md#flyway-versionen)
(auf `main` erst mit dem Merge von `release/0.1.1`), mechanisch geprüft von der
Repository-CI ([vaultdex/Vaultdex#980](https://github.com/vaultdex/Vaultdex/issues/980)).

**Sonar.** Null offene Sonar-Issues prüft `board.mjs handoff` bereits mechanisch
([#134](https://github.com/vaultdex/workflow-kit/issues/134)); nichts weiter zu tun.

**Review-Bots im Quota.** Ist ein Reviewer wegen Quota nicht verfügbar, gilt der
bestehende Schritt „confirmed unavailable“ im [Review loop](CONTRIBUTING.md#review-loop):
Reviewer, Ursache und Beleg in der PR festhalten und die Einschränkung im
Übergabekommentar nennen.

**Eigene Scratch-Verzeichnisse.** Hilfsdateien (Kommentartexte, Skripte, Logs) liegen
je Issue in einem eigenen Verzeichnis, zum Beispiel im Session-Scratchpad oder neben
dem Klon in `<issue>-scratch/`, nie unter gemeinsamen Dateinamen.

**Worktree-Schutzprüfung von Claude Code.** Sie lehnt zusammengesetzte Shell-Befehle
ab: `$(…)` in Pipes, Schleifen mit `git` oder `gh` und Inline-`node` oder
`python`. Stattdessen einfache Einzelbefehle oder eine Skriptdatei im eigenen
Scratch-Verzeichnis verwenden, statt mehrfach zu probieren.
