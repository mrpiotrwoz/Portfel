# Portfel XTB – strona i widżet bez Claude

Strona z portfelem (działa jak aplikacja na iPhonie i iPadzie) oraz widżet. Kursy pobiera automatycznie GitHub, za darmo i bez zużywania tokenów Claude.

## Co jest w środku

- `index.html`: strona portfela (PWA). Import raportu XTB, wykresy, historia, dywidendy, podatek.
- `data/watchlist.json`: lista spółek, dla których pobierane są kursy.
- `data/latest.json`, `data/history.json`: kursy i historia. Zapisuje je skrypt, nie edytuj ręcznie.
- `scripts/update.mjs`: skrypt pobierający kursy. Akcje z Yahoo Finance (zapasowo ze Stooq), WIG ze Stooq, waluty z NBP.
- `.github/workflows/kursy.yml`: harmonogram. Uruchamia skrypt w dni robocze po sesji GPW i po sesji w USA.
- `widget/portfel-widget.js`: szablon widżetu dla aplikacji Scriptable.

Twoje ilości akcji, koszty i wpłaty **nie trafiają do repozytorium**. Strona trzyma je tylko w przeglądarce na danym urządzeniu.

## Uruchomienie (ok. 15 minut, jednorazowo)

1. Załóż konto na https://github.com, jeśli go nie masz.
2. Utwórz nowe repozytorium: przycisk **New repository**, nazwa `portfel`, ustawienie **Public**, bez README. Na darmowym koncie GitHub Pages działa tylko dla repozytoriów publicznych.
3. W repozytorium kliknij **uploading an existing file** i przeciągnij **całą zawartość** rozpakowanego folderu `portfel`, razem z folderem `.github`. Zatwierdź przyciskiem **Commit changes**.
   - Na Macu folder `.github` jest ukryty. W Finderze naciśnij `Cmd + Shift + .`, żeby go zobaczyć.
4. **Settings → Pages**: Source **Deploy from a branch**, Branch **main**, folder **/ (root)**, **Save**. Po 1–2 minutach strona będzie pod adresem `https://TWOJ-LOGIN.github.io/portfel/`.
5. **Settings → Actions → General → Workflow permissions**: zaznacz **Read and write permissions**, **Save**. Bez tego skrypt nie zapisze kursów.
6. Pierwsze pobranie: **Actions → Kursy → Run workflow**. Po minucie wejdź w uruchomienie i sprawdź log kroku „Pobierz kursy”. Na końcu powinno być `Odświeżono 23/23 kursów`.

## Na iPhonie i iPadzie

1. Otwórz adres strony w **Safari**, potem **Udostępnij → Do ekranu początkowego**.
2. Otwórz aplikację z ikony, stuknij **Importuj z XTB** i wybierz plik `portfel-kopia.json` (np. z iCloud Drive). Portfel pojawi się od razu.
3. Zrób to na każdym urządzeniu, bo dane portfela są zapisywane osobno na każdym.
4. Po zmianach (nowy raport, edycja) przycisk **Zapisz kopię** daje nowy plik `.json` do przeniesienia na inne urządzenie.

## Widżet (Scriptable)

1. Zainstaluj darmową aplikację **Scriptable** z App Store.
2. Utwórz nowy skrypt (+), wklej zawartość pliku `portfel-widzet.js`, który zawiera już Twoje pozycje. W drugiej linii ustawień zmień `BASE_URL` na adres swojej strony.
3. Uruchom skrypt raz w aplikacji, żeby sprawdzić podgląd.
4. Na ekranie głównym przytrzymaj puste miejsce, wybierz **Edytuj → Dodaj widżet → Scriptable**, wybierz rozmiar i w ustawieniach widżetu wskaż skrypt.
5. Po zmianie ilości akcji popraw tablicę `HOLDINGS` w skrypcie.

## Dodanie lub usunięcie spółki

Edytuj `data/watchlist.json` na GitHubie (ikona ołówka). Każda spółka ma pola `sym` (symbol XTB, np. `CDR.PL`), `name` i `yahoo` (symbol Yahoo: spółki z USA bez końcówki, np. `MSFT`, polskie z `.WA`, np. `CDR.WA`). Strona sama podpowie, dla których spółek brakuje kursów.

Gdy spółka zmieni nazwę lub ticker, a XTB dalej pokazuje stary symbol, zostaw stary `sym` i dopisz nowe symbole źródeł: `cnbc` (np. `HELP`), `google` (np. `HELP:NASDAQ`), `stooq` (np. `help.us`) i `yahoo`. Tak jest ustawiony Cybin (`CYBN.US`), który od stycznia 2026 notowany jest jako Helus Pharma (`HELP`).

## Dobrze wiedzieć

- Kursy są z darmowych źródeł i mogą być opóźnione. Przy podglądzie portfela raz dziennie to nie przeszkadza.
- GitHub może uruchamiać harmonogram z opóźnieniem do kilkudziesięciu minut.
- Wiadomości, sygnały, dywidendy i kalendarz pochodzą z ostatniej analizy Claude i nie odświeżają się automatycznie.
