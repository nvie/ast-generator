[![npm](https://img.shields.io/npm/v/ast-generator.svg)](https://www.npmjs.com/package/ast-generator)
[![Build Status](https://github.com/nvie/ast-generator/workflows/test/badge.svg)](https://github.com/nvie/ast-generator/actions)

TypeScript code generator for AST nodes based on the following grammar format:

```
Circle {
  cx: number
  cy: number
  r: number
}

Rect {
  x: number
  y: number
  width: number
  height: number
}

@Shape =
  | Circle
  | Rect

Document {
  version?: number
  shapes: @Shape*
}
```
