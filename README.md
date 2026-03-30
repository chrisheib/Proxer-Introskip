# Proxer Anime Skip

Browser-Erweiterung für proxer.me, um Intros/Outros von Animes automatisch zu überspringen.

Erstelle eine Markierung in den ersten Sekunden des Intros, und die Erweiterung überspringt von da an alle weiteren Intros dieser Serie.

Die Erkennung erfolgt über eine sehr schnelle Bilderkennung.

Unterstützt Chrome und Firefox mit gemeinsamem Code.

## Installation

Lade die Erweiterung aus dem zu deinem Browser passenden Store herunter.

### Chrome/Edge

tbd

### Firefox

tbd

## Features

### 2026-03-31 - Global sound fade option
Fügt eine globale Einstellung hinzu, um nach dem Skippen einen Audio-Fade einzuschalten, um nicht das Trommelfell zu verlieren.

## Entwicklung

### Build

- Bauen: `./build.sh`
- Watch-Modus: `./watch.sh`
- Pakete erstellen (Chrome + Firefox): `./pack.sh`

### Release-Artefakte

Nach `./pack.sh` liegen die ZIP-Dateien in `release/`:

- `proxer-anime-skip-v<version>.zip` (Chrome)
- `proxer-anime-skip-firefox-v<version>.zip` (Firefox)