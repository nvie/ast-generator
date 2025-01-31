## [Unreleased]

- Put settings in a new `settings` block
- Add understood settings `discriminator`, and `output`
- Generate to `generated-ast.ts` by default, but allow specifying it through
  `output = "../somewhere-else.ts"`
- No longer support passing output file as a CLI argument

## [0.5.0] - 2025-01-30

- **Breaking** Node unions no longer have to be written using `@MyUnion` syntax. This is
  now "just" `MyUnion`. The definition itself determines whether it's a union or a basic
  node.
- Added support for literal types, e.g., `op: ">" | "<" | ">=" | "<="` (previously the
  closest best thing was `op: string`).

## [0.4.0] - 2025-01-29

- Every Node now has generated `.children` and `.descendants` iterator properties, which
  enable you to iterate over all of its children in a type-safe manner.
- Add support for addition of externally defined semantic properties/methods.
- Add support for changing discriminator field, using `set discriminator "_kind"` in the
  grammar.
- Change default discriminator field to `type`.
- **Breaking** No longer generates `visit()` method. You can now use the built-in
  `.children` and `.descendants` properties (available on every Node) or `defineMethod()`
  to implement your own custom visitors.

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
