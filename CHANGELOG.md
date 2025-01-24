## [Unreleased]

- Add support for changing discriminator field, using `set discriminator "_kind"` in the
  grammar
- Add support for addition of external semantic properties/methods

## [0.3.0] - 2025-01-20

- New definition language
- Internals rewritten in Ohm

## [0.2.4] - 2025-01-09

- Add support for `null` inside literal field types

## [0.2.3] - 2025-01-08

- Fix bug when using CLI:
  `The data argument must be of type string or an instance of Buffer, TypedArray, or DataView.`

## [0.2.2] - 2025-01-08

- Make `typescript` a peer dependency
- Upgrade some (dev) dependencies

## [0.2.1] - 2024-02-28

- Made `_kind` enumerable again.

## [0.2.0] - 2024-02-28

- Made the first-defined node the start node for the grammar. It no longer has to be named
  "Document" per se.
- Made `_kind` and `range` fields non-enumerable.

## [0.1.0]

Modernize repo, rewrite in TypeScript.

## [0.0.x]

Did not keep a changelog yet.
