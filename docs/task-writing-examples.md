# Beispiele für Aufgaben und PRs

Erfundene Beispiele für die [Schreibregeln](CONTRIBUTING.md#issues). Dateien,
Befehle und Ergebnisse gehören zu einem Beispielprojekt. Für echte Aufgaben die
tatsächlichen Einstiegspunkte, Metadaten und Belege einsetzen.

## Kleine Aufgabe: Startbefehl in der README korrigieren

### Wofür brauchen wir das?

Die README nennt `npm run start`. Das Beispielprojekt stellt nur `npm run dev`
bereit. Neue Mitwirkende können der Anleitung deshalb nicht folgen.

### Was bringt es uns?

Der dokumentierte Befehl startet die vorhandene Entwicklungsumgebung.

### Was muss gemacht werden?

Nur den falschen Befehl im Abschnitt „Lokal starten“ ersetzen. Keine Skripte ändern.

### Wie soll es umgesetzt werden?

`scripts.dev` in `package.json` prüfen, dann den Befehl in `README.md` korrigieren.
Andere Setup-Schritte bleiben erhalten.

### Woran erkennen wir, dass es fertig ist?

- [ ] `npm run dev` startet nach dokumentierter Vorbereitung den lokalen Dienst.
- [ ] README-Befehl und Skript stimmen überein; Diff enthält nur die Korrektur.

### Abhängigkeiten und Wiederaufnahme

Nach aktuellem Abgleich keine bekannt. Falls der Start scheitert, Fehlermeldung
und Ursache eingrenzen; keinen erfolgreichen Durchlauf behaupten.

## Größere Aufgabe: Wiederholte Bestätigung erzeugt keinen doppelten Bestand

### Wofür brauchen wir das?

Im Beispielprojekt legt `POST /requests/{id}/confirm` nach einem Netzwerkfehler
bei Wiederholung einen zweiten Bestandseintrag an. Reproduktion: dieselbe Anfrage
zweimal mit demselben Bestätigungsschlüssel senden. Erwartet ist ein Eintrag.

### Was bringt es uns?

Nutzer können eine unklare Antwort sicher wiederholen, ohne doppelte Bestände
manuell entfernen zu müssen.

### Was muss gemacht werden?

Bestätigung dauerhaft gegen Wiederholung und parallele Aufrufe absichern.
Besitzrechte und Abbruchregeln erhalten. Keine neue Queue oder Workflow-Engine.

### Wie soll es umgesetzt werden?

1. `RequestController.confirm` bis `ConfirmationService.confirm` und dessen
   Bestandswriter verfolgen. Alle Aufrufer prüfen. Vorhandene Transaktion und
   HTTP-Fehlerformate verwenden.
2. Sitzungs-Owner und bestätigbaren Anfragestatus vor Schreiben prüfen.
   Client-ID allein erlaubt keinen Zugriff auf fremde Anfragen.
3. Bestätigungsschlüssel, erlaubte Nutzlast und resultierende Bestands-ID in
   derselben DB-Transaktion wie den Bestand speichern. Eindeutigkeitsregel
   auf Owner und Schlüssel verhindert parallele Duplikate.
4. Gleiche Nutzlast/gleicher Schlüssel gibt gespeicherte Bestands-ID zurück.
   Andere Nutzlast bei gleichem Schlüssel liefert den bestehenden Konfliktfehler.
   Fehlgeschlagene Transaktion hinterlässt weder Bestätigung noch Bestand.
5. Abbruch vor Bestätigung verhindert Übernahme; Abbruch danach löscht keinen
   Besitz. Browser-Retry verwendet denselben Schlüssel statt eines neuen.
6. PostgreSQL-HTTP-Test `ConfirmationHttpTest` ergänzen. Akzeptierte API-Änderungen
   in OpenAPI, Client und UI gemeinsam nachziehen.

### Woran erkennen wir, dass es fertig ist?

- [ ] Zwei gleiche HTTP-Aufrufe liefern dieselbe ID; PostgreSQL enthält einen Bestand.
- [ ] Parallele Aufrufe erzeugen ebenfalls nur einen Bestand.
- [ ] Fremder Owner, abgebrochene Anfrage und geänderte Nutzlast werden abgelehnt.
- [ ] Erzwungener Schreibfehler hinterlässt keine halben Daten; Retry funktioniert.
- [ ] Beispielbefehl `./gradlew test --tests '*ConfirmationHttpTest'` besteht gegen
  echte Testdatenbank. Ein UI-Mock ersetzt diesen Nachweis nicht.

### Abhängigkeiten und Wiederaufnahme

Im Beispiel ist der Bestandswriter geliefert; keine offenen internen Vorgänger.
Benötigt wird eine eigene kurzlebige PostgreSQL-Testdatenbank. Bei fehlendem
Dockerzugriff konkrete fehlgeschlagene Prüfung festhalten und Umgebung
wiederherstellen; nicht gegen fremde Bestände testen.

Kommentarfrage „Soll zweimal klicken zwei Bestände erzeugen?“ anhand des
akzeptierten Vertrags im Haupttext beantworten und Entscheidung verlinken.
Fehlt die Produktentscheidung, konkrete Frage mit Empfehlung offen lassen,
statt das Implementierungsmodell raten zu lassen.

## Wartebedingung: erst nach einem Release oder Zeitpunkt

Eine Aufgabe, die erst nach dem Tag `v0.1.1` oder ab einem UTC-Zeitpunkt starten
darf, trägt die Bedingung maschinenlesbar im Abschnitt „Abhängigkeiten und
Wiederaufnahme“ (eine Zeile je Bedingung, nur der Wert, keine Zusätze):

> ### Abhängigkeiten und Wiederaufnahme
>
> Wartet bis: v0.1.1
>
> Wartet bis: 2026-10-12T18:51Z
>
> Die Migration setzt das Release voraus; die zweite Zeile hält den Start bis nach
> dem Wartungsfenster zurück.

`board.mjs next` und `check` melden die Aufgabe BLOCKED, bis der Tag existiert und
der Zeitpunkt erreicht ist; eine ungültige Zeile gilt als UNKNOWN.

## PR zur kleinen Beispielaufgabe

### Was wurde geändert und warum?

Die README nennt im Abschnitt „Lokal starten“ jetzt `npm run dev` statt des nicht
vorhandenen `npm run start`. Neue Mitwirkende können die Entwicklungsumgebung
damit nach Anleitung starten.

Closes #N

Ein Abschnitt **Prüfung und Grenzen** entfällt hier: Die Prüfung ist Routine und im
Issue belegt. Nicht ausgeführte Prüfungen würden dort ausdrücklich als offen stehen.

## Menschliche Mitwirkung

Beispiel für eine offene Produktentscheidung als erster Abschnitt eines Issues
(zusätzlich Label `needs-human-input`):

> ## Menschliche Mitwirkung nötig
> - **Wer:** Produkt-Owner.
> - **Was fehlt:** Sollen abgelehnte Datensätze eigene Reviewfälle bleiben?
>   Empfehlung A: nur Identitätsfälle anzeigen, Datensatzbelege behalten.
>   Alternative B: Datensatzfälle anzeigen und bei Auflösung mit schließen.
> - **Wirkung:** Umsetzung und Abnahme der Bereinigung sind blockiert; die
>   Reproduktion ist schon möglich.
> - **Antwortweg:** A oder B im Issue oder im Agent-Chat. Danach konkretisiert der
>   Agent Umsetzung und Tests im Issue.
