import { describe, expect, it } from "vitest"

import { parseGrammarFromString } from "../generator.js"

describe("parsing grammars", () => {
  it("parses a grammar", () => {
    expect(
      parseGrammarFromString(`
semantic property myProp1
semantic property myProp2
semantic method doSomething()
semantic method doSomethingElse()
semantic property myProp3

# This is a comment
Abc {
  x0:
  string
  x1: string+
  x2: string*
  x3?:string y0:Xyz
  y1: Xyz*
  y2: Xyz+
  y3?: Xyz
  y4?: Xyz
  z0: Pqr
  z1: Pqr+
  z2: Pqr*
  z3?: Pqr
}

Xyz = Pqr | Stu

Pqr {
  p?: number
}

# This is a comment
Stu {
  s: number
  op: ">" | "<" | ">=" | "<="
  version?: 1
  bits: 0 | 1 *
}
`)
    ).toMatchSnapshot()
  })
})

describe("checking document validity", () => {
  it("thrown where there is a duplicate def (node)", () => {
    expect(() =>
      parseGrammarFromString(`
      Foo {}
      Foo {}
   `)
    ).toThrow("Duplicate definition of 'Foo'")
  })

  it("thrown where there is a duplicate union def (node)", () => {
    expect(() =>
      parseGrammarFromString(`
      Foo {}
      Bar {}
      Bar = Foo
      Bar = Bar
   `)
    ).toThrow("Duplicate definition of 'Bar'")
  })

  it("thrown where there is a duplicate def (node + union)", () => {
    expect(() =>
      parseGrammarFromString(`
      Foo {}
      Bar {}
      Foo = Bar
   `)
    ).toThrow("Duplicate definition of 'Foo'")
  })

  it("thrown when there is an unknown reference (node)", () => {
    expect(() =>
      parseGrammarFromString(`
      Foo { bar: Ba }
      #          ^^ Typo, should fail
      Bar { }
   `)
    ).toThrow("Cannot find 'Ba'")
  })

  it("thrown when there is an unknown reference (node)", () => {
    expect(() =>
      parseGrammarFromString(`
      Foo { bar: Ba }
      #          ^^ Typo, should fail
      Bar = Qux | Mutt
      Qux {}
      Mutt {}
   `)
    ).toThrow("Cannot find 'Ba'")
  })

  it("thrown when there is an unused node def", () => {
    expect(() =>
      parseGrammarFromString(`
      Foo { }
      Bar { }
   `)
    ).toThrow("Unused definition 'Bar'")
  })

  it("thrown when there is an unused union def", () => {
    expect(() =>
      parseGrammarFromString(`
      Foo { }
      Bar = Foo
   `)
    ).toThrow("Unused definition 'Bar'")
  })

  it.skip("[todo later] thrown when there is a circular ref", () => {
    expect(() =>
      parseGrammarFromString(`
      Foo { foo: Foo }
   `)
    ).toThrow("Circular ref 'Foo'")
  })
})
