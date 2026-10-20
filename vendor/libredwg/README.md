# LibreDWG Web (vendored)

Каталог содержит библиотеку `@mlightcad/libredwg-web` 0.8.1 — JavaScript/WASM
обёртку над LibreDWG для чтения файлов DWG в браузере.

- Официальный репозиторий: https://github.com/mlightcad/libredwg-web
- Лицензия: GPL-3.0 (см. `LICENSE-GPL-3.0.txt`)
- LibreDWG: https://www.gnu.org/software/libredwg/

## Файлы

| Файл | Назначение |
| --- | --- |
| `libredwg-web-glue.js` | Emscripten-модуль, адаптированный для подключения обычным `<script>` |
| `libredwg-web.umd.js` | UMD-бандл API (`window['libredwg-web']`) |
| `libredwg-wasm-gzip.js` | `libredwg-web.wasm`, сжатый gzip и упакованный в base64 |

WASM встроен в base64, чтобы импорт DWG работал при открытии `index.html`
напрямую через `file://`, без локального веб-сервера.

Загрузка выполняется лениво — только при первом выборе файла DWG.
