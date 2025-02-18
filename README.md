<img src="agent/img/logo_blue2.bmp" alt="Logo" width="300"/>

# Firecrawl Enhanced Web Information System

Ten system, skonfigurowany z pakietem Firecrawl, umożliwia śledzenie i pozyskiwanie informacji z wybranych, dozwolonych stron internetowych. Dodatkowo, potrafi generować dokumenty bazujące na zgromadzonych danych z sieci.

## Instalacja 

1. Pobierz repozytorium `git clone`
2. Dodaj swój klucz [OpenAI API](https://platform.openai.com/account/api-keys) do pliku .env
3. Dodaj swój klucz Firecrawl do pliku .env
4. Zainstaluj zależności poleceniem `bun install`
5. Uruchom skrypt poleceniem `bun lecimy`

⚠️ **UWAGA!** ⚠️

Jedyną dostępną domeną do przeszukania jest dokumentacja Laravela. 
Kolejne domeny można dodać z poziomu pliku services/WebSearch.ts