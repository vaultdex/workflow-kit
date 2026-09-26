# Beispiele für Aufgaben und PRs

Erfundene Beispiele für die [Schreibregeln](CONTRIBUTING.md#issue-plans-and-pr-descriptions).
Dateien, Befehle und Ergebnisse gehören zum Beispielprojekt; keine Vaultdex-Aufträge
oder behaupteten Prüfergebnisse. Für echte Aufgaben tatsächliche Einstiegspunkte,
Metadaten und Belege einsetzen.

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

## PR zur kleinen Beispielaufgabe

### Was wurde geändert?

Die README nennt im Abschnitt „Lokal starten“ jetzt `npm run dev`.
Im echten PR hier das vollständig gelieferte Issue mit `Closes #N` verknüpfen.

### Warum war das nötig?

Der bisher dokumentierte Befehl `npm run start` existiert nicht.

### Was bringt es uns?

Neue Mitwirkende können die Entwicklungsumgebung anhand der Anleitung starten.

### Prüfung und Grenzen

Beispiel für einen **tatsächlich ausgeführten** Nachweis: „Dokumentierte Vorbereitung
und `npm run dev` auf eigenem Testaufbau bestanden; Diff enthält nur die README.“
Nicht ausgeführte Prüfung stattdessen ausdrücklich als offen benennen.
