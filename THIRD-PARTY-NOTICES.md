# Third-party notices

Cycle bundles a parser runtime and twelve grammars so that installation needs no compiler and no
network. Every one of them is MIT licensed. The permission notice below applies to all of them, and
the copyright holders are listed per component.

## web-tree-sitter

`vendor/runtime/tree-sitter.cjs`, `vendor/runtime/tree-sitter.wasm`
From https://github.com/tree-sitter/tree-sitter

    Copyright (c) 2018 Max Brunsfeld

## Grammars

Each is one `.wasm` file under `vendor/grammars`.

| File | Upstream | Copyright |
| --- | --- | --- |
| `c-sharp.wasm` | https://github.com/tree-sitter/tree-sitter-c-sharp | Copyright (c) 2014-2023 Max Brunsfeld, Damien Guard, Amaan Qureshi, and contributors. |
| `cpp.wasm` | https://github.com/tree-sitter/tree-sitter-cpp | Copyright (c) 2014 Max Brunsfeld |
| `css.wasm` | https://github.com/tree-sitter/tree-sitter-css | Copyright (c) 2018 Max Brunsfeld |
| `go.wasm` | https://github.com/tree-sitter/tree-sitter-go | Copyright (c) 2014 Max Brunsfeld |
| `java.wasm` | https://github.com/tree-sitter/tree-sitter-java | Copyright (c) 2017 Ayman Nadeem |
| `javascript.wasm` | https://github.com/tree-sitter/tree-sitter-javascript | Copyright (c) 2014 Max Brunsfeld |
| `php.wasm` | https://github.com/tree-sitter/tree-sitter-php | Copyright (c) 2017 Josh Vera, GitHub; Copyright (c) 2019 Max Brunsfeld, Amaan Qureshi, Christian Froystad, Caleb White |
| `python.wasm` | https://github.com/tree-sitter/tree-sitter-python | Copyright (c) 2016 Max Brunsfeld |
| `ruby.wasm` | https://github.com/tree-sitter/tree-sitter-ruby | Copyright (c) 2016 Rob Rix |
| `rust.wasm` | https://github.com/tree-sitter/tree-sitter-rust | Copyright (c) 2017 Maxim Sokolov |
| `tsx.wasm` | https://github.com/tree-sitter/tree-sitter-typescript | Copyright (c) 2017 Max Brunsfeld |
| `typescript.wasm` | https://github.com/tree-sitter/tree-sitter-typescript | Copyright (c) 2017 Max Brunsfeld |

## The MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## What is not recorded here

The vendored files carry no version or commit metadata, and nothing in the build records where they
were taken from. The licences above were read from each project's current LICENSE file, and every
one of them has been MIT for the life of the project. Pinning the exact upstream revision of each
bundled artifact is open work, and until it is done this file names the projects rather than the
revisions.
