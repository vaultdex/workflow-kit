# Parallele Driver

Beobachtungen und Verweise für mehrere Agent-Driver, die gleichzeitig auf einem
Rechner arbeiten (zuerst am 06.10.2026 in vaultdex/Vaultdex). Verbindlich bleibt
[AGENT_RULES.md](../AGENT_RULES.md); die [Driver-Regeln](#driver-regeln) am Ende
legen sie für Driver-Subagenten aus. Ein Briefing verweist darauf und nennt nur die
Besonderheiten des Issues.

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

**GitHub-Kontingent.** Das GraphQL-Kontingent (5.000 Punkte pro Stunde) gilt für das ganze
Konto und wird von allen Drivern gemeinsam verbraucht; ist es leer, scheitert jeder
`board.mjs`-Befehl bis zum Reset. Gemessene Kosten: eine Lesung von `reviews`/`wait` kostet
2 Punkte, `check` 1 (2 bei einem Issue, das nur offene Vorgänger hält), `next` 3 (4 bei einem Stapel-Kandidaten, je weitere 30 offene Issues 1 mehr). `wait` fragt zuerst nach 60 s, dann mit wachsendem Abstand bis
5 Minuten (bei Neuigkeiten wieder von vorn), also etwa 20 bis 40 Punkte pro Stunde und Driver
statt 120 bei festem Minutentakt. Als Budget gilt: Zahl der Driver mal 40 Punkte, dazu der eigene
Verbrauch der Agents; höchstens 20 parallele `wait` (rund 800 Punkte pro Stunde, ein Sechstel
des Kontingents). `wait` und `reviews` melden den Rest in einer Zeile (`quota: …`).
`wait`, `reviews` und `handoff` schlafen bei einer Sperre oder bei weniger als 300 (`wait`)
beziehungsweise 50 Punkten bis zum Reset (`rate limited until …`) und fragen danach weiter; bei
einer kurzen Drosselung („secondary rate limit“) warten sie 1, 2, dann 4 Minuten statt bis zum
Reset. Alle anderen Befehle brechen mit der Zeit des nächsten Versuchs ab (Uhrzeit und Minuten bis dahin). Eigene Schleifen um `gh api graphql` sind deshalb nicht nötig.
Rest und Reset stammen aus den Headern `x-ratelimit-remaining` und `x-ratelimit-reset` der eigenen Antworten
(auch der abgewiesenen); zeigt eine Abweisung selbst freies Kontingent, fragt der Befehl sofort erneut,
statt auf eine Reset-Zeit zu warten. `gh api rate_limit` ist kein Beleg: es zeigte am 07.10.2026 für GraphQL einen
veralteten Wert. Wer die Zeit selbst braucht, fragt `gh api graphql -f query='query{rateLimit{remaining resetAt}}'`;
diese Abfrage antwortet auch bei leerem Kontingent.
Viele Issues auf einmal: `board.mjs new --from FILE` statt einer Schleife um `new`. Jede Abfrage und jede
Mutation kostet 1 Punkt, ein einzelnes `new` braucht 4 Anfragen (vorher 8 bis 9), die Sammel-Anlage für bis zu 16
Issues zusammen 4 ([README](../README.md#board-commands)). Lesen Sie Issues und Kommentare über REST
(`gh api repos/OWNER/REPO/issues/N`): `gh issue view` und `gh pr view` fragen GraphQL.

**Review-Bots im Quota.** Ein Reviewer, auf den das Projekt nicht angewiesen ist
(CodeRabbit auf dem Free-Plan), steht als `"optionalReviewers"` in
`.github/workflow-project.json` ([SETUP](../SETUP.md#3-board-and-labels)). Für ihn gibt es
kein erneutes Anfordern, kein Warten und kein Ersatz-Review; `board.mjs` wartet nie auf
seine Spuren. Die Übergabe nennt ihn nur, wenn er etwas gefunden hat. Ist ein Pflicht-Reviewer
wegen Quota nicht verfügbar, gilt der Schritt „confirmed unavailable“ im
[Review loop](CONTRIBUTING.md#review-loop): Reviewer, Ursache und Beleg in der PR
festhalten und die Einschränkung im Übergabekommentar nennen.

**Eigene Scratch-Verzeichnisse.** Hilfsdateien (Kommentartexte, Skripte, Logs) liegen
je Issue in einem eigenen Verzeichnis, zum Beispiel im Session-Scratchpad oder neben
dem Klon in `<issue>-scratch/`, nie unter gemeinsamen Dateinamen.

**Worktree-Schutzprüfung von Claude Code.** Sie lehnt zusammengesetzte Shell-Befehle
ab, auch im Bypass-Modus: `$(…)` in Pipes, Schleifen mit `git` oder `gh`,
Inline-`node` oder `python`, Heredocs und Umleitungen auf Pfade außerhalb des
Worktrees, `cd … && git` sowie Variablen in `gh`-Pfaden. Stattdessen einfache
Einzelbefehle oder eine Skriptdatei im eigenen Scratch-Verzeichnis verwenden, statt
mehrfach zu probieren. Dateien, Kommentartexte und PR-Bodies mit dem Write-Werkzeug
schreiben und per `--body-file` übergeben, nicht per Heredoc.

## Driver-Regeln

Allgemeine Regeln für jeden Driver-Subagenten. Projektspezifische Regeln und die
Modellwahl stehen hier nicht.

0. **Neuer Worktree: Kit zuerst.** Ein Worktree mit `isolation: worktree` startet mit leerem
   Kit-Submodul, weil die Start-Hooks für das Projektverzeichnis der Eltern laufen: als Erstes
   `git submodule update --init .vendor/workflow-kit`, dann AGENT_RULES.md lesen.
1. **Ein Issue bis „Human review“ treiben.** Früher enden nur bei einem menschlichen
   Gate (Merge, Secrets, Backlog→Ready, Produktentscheidung) oder bei einem Blocker
   (`board.mjs check` meldet BLOCKED oder UNKNOWN, eine Voraussetzung ändert sich;
   [Blockers and scope](CONTRIBUTING.md#blockers-and-scope)): erst im Issue
   kommentieren, dann berichten.
2. **Regeln vom Ziel-Release-Branch lesen.** AGENTS.md und Kit-Regeln stammen vom
   Release-Branch, auf den die PR zielt, nicht nur von `main`; eine Regel kann nur
   dort stehen. Danach [Start or resume](../AGENT_RULES.md#start-or-resume) mit
   `Agent: …, Session: …`. Den Issue-Branch zweigt der Driver vom Ziel-Release-Branch
   ab (`--base` im `gh issue develop` der [Delivery](CONTRIBUTING.md#delivery)-Regel
   ist dann dieser Branch, nicht `main`). Bei STACKABLE ist es der Branch des Basis-PR
   ([Stacked pull requests](CONTRIBUTING.md#stacked-pull-requests)). Er bleibt ein fremder
   Branch (Regel 3): der Driver zweigt davon ab und liest ihn, pusht ihn aber nie.
3. **Fremde Branches in Ruhe lassen.** `codex/*`-Branches und Branches anderer
   Driver nicht anfassen, auch wenn der eigene Branch `codex/*` heißt; nur der eigene
   Issue-Branch gehört dem Driver. Überschneidungen melden.
4. **Warten ohne Handarbeit.** Abweichend von [AGENT_RULES.md](../AGENT_RULES.md#economy)
   und [Review loop](CONTRIBUTING.md#review-loop) Schritt 3 gilt für Driver-Subagenten:
   `board.mjs wait PR` im Vordergrund ausführen, weil ein Subagent erst am Ende seines
   Zuges von Hintergrundaufgaben erfährt. `wait` endet nach 9 Minuten von selbst (`--max-minutes N`,
   0 = unbegrenzt) mit Exit-Code 4 und der Zeile `still waiting: call wait again`, damit das
   Bash-Werkzeug es nicht nach 10 Minuten in den Hintergrund schiebt: bei Exit 4 einfach erneut
   aufrufen. Nach DONE nicht auf einen Reviewer
   ohne Spur pollen (ein Review, das nie startet) und keinen Review von Hand anfordern
   (kein `@codex review`); fehlt die Spur, nennt der Übergabe-Kommentar das
   ([Review loop](CONTRIBUTING.md#review-loop) Schritt 3). Freitext-Ankündigungen anderer Bots
   erkennt `wait` nicht ([README](../README.md#board-commands)); eine angekündigte
   Review verfolgt der Driver von Hand bis zum Ergebnis oder Stall und führt
   `handoff` erst danach aus. Review-Subagenten ebenfalls im Vordergrund starten;
   `tasks/*.output` nicht pollen, die Datei bleibt leer.
5. **Shell und Werkzeuge.** Ein einfacher Befehl pro Bash-Aufruf, vom Worktree-Root aus,
   mit literalen Pfaden; Details im Absatz zur Worktree-Schutzprüfung oben.
   - Tests: lokal nur die betroffenen (`--test-name-pattern` oder eine Testdatei), die
     ganze Suite läuft in der CI. Führt die Projekt-CI sie für diesen Head nicht aus,
     läuft sie einmal vor der Übergabe im Hintergrund mit Logdatei. Das Kit fährt sie in
     seiner CI, Kit-Driver testen lokal nur gezielt.
   - Dateien: mit Edit und Write oder mit einem Node-Skript aus einer Datei ändern;
     Heredoc, Python und sed verlieren Backslashes.
   - Suchen: auf Pfade eingrenzen oder erst mit `-l` die Dateien finden.
   - Ziel-Stand: Suchen und Lesen laufen gegen den Stand des Ziel-Branches, bei abweichendem
     Checkout mit `git grep … origin/<Ziel-Branch>`.
   - Such- und Explore-Subagenten im Vordergrund (`run_in_background: false`), damit genau ein
     Bericht zurückkommt; Hintergrund nur für lange Prüfläufe mit eigener Benachrichtigung.
   - Warten: auf die Benachrichtigung der eigenen Hintergrundaufgabe; Prozessnamen
     (`node.exe`) gehören auch anderen Drivern.
   - GitHub lesen mit `gh api repos/…` (REST, kostet kein GraphQL-Kontingent) statt `gh pr view|checks|list`
     und `gh issue view|list` (GraphQL); Status und Felder schreibt weiter `board.mjs`.
   - Kommentare eines Issues: `gh api repos/OWNER/REPO/issues/N/comments`.
   - Worktree: der Driver arbeitet im eigenen Worktree, nie in dem der Eltern-Session;
     hat er keinen, legt er ihn als Erstes an. Scratch-Dateien tragen die Issue-Nummer.
   - Kit-Stand: Hooks und Skills eines Subagenten kommen aus dem Start-Worktree der
     Eltern-Session. Sie hält vor dem Start von Drivern ihr Kit auf dem Pin-Stand
     (`git submodule update --init .vendor/workflow-kit`), damit neue Regeln für die
     Driver gelten.
6. **Retro vor der Übergabe.** Den Skill `retro` mit dem Skill-Werkzeug aufrufen
   (die Kit-Kopie ist aufrufbar, [Abweichung](matt-pocock.md)); Quelle ist die eigene
   Session ([Review loop](CONTRIBUTING.md#review-loop) Schritt 5). Eine
   Kurzdurchsicht aus dem Kopf ersetzt ihn nicht.
7. **Abschlussbericht** mit höchstens 12 Zeilen: PR, zurückgelesener Status,
   Folge-Issues, Überschneidungen, Reibung.
