import fs from "fs"
import * as ohm from "ohm-js"
import pathLib from "path"
import prettier from "prettier"
import invariant from "tiny-invariant"

type TSNativeType = {
  kind: "TSNativeType"
  typeName: "string" | "number" | "boolean"
}

type TSLiteralType = {
  kind: "TSLiteralType"
  constant: string | number | null
}

type BuiltinTS = {
  kind: "BuiltinTS"
  types: (TSNativeType | TSLiteralType)[]
}

type NodeRef = {
  kind: "NodeRef"
  name: string
}

// e.g. MyNode or string | boolean
type TypeRef =
  | BuiltinTS // e.g. boolean, or string | boolean, or 42 | "foo"
  | NodeRef

// e.g. MyNode+
type RepeatedTypePattern =
  | TypeRef
  | {
      kind: "List"
      of: TypeRef
      min: 0 | 1
    }

// e.g. MyNode?
type TypePattern =
  | RepeatedTypePattern
  | {
      kind: "Optional"
      of: RepeatedTypePattern
    }

type Def = UnionDef | NodeDef

// e.g. Foo { bar: string } style
type NodeDef = {
  kind: "NodeDef"
  name: string
  fieldsByName: LUT<Field>
  fields: Field[]
}

// e.g. Foo = Bar | Qux
type UnionDef = {
  kind: "UnionDef"
  name: string
  members: NodeRef[]
}

type Field = {
  kind: "Field"
  name: string
  pattern: TypePattern
}

type Grammar = {
  kind: "Grammar"
  settings: Settings
  discriminator: string

  externals: SemanticDeclaration[]
  startNode: string

  nodeDefsByName: LUT<NodeDef>
  nodeDefinitions: NodeDef[] // Sorted list of nodes

  unionDefsByName: LUT<UnionDef>
  unionDefinitions: UnionDef[] // Sorted list of node unions

  // Convenience helper methods
  // isBuiltinRef(ref: TypeRef): boolean
  isUnionRef(ref: TypeRef): boolean
}

type Settings = {
  kind: "Settings"
  assignments: Assignment[]
  record: Record<string, string>
}
type Assignment = { kind: "Assignment"; key: string; value: string }
type SemanticDeclaration = SemanticPropertyDeclaration | SemanticMethodDeclaration
type SemanticPropertyDeclaration = { type: "property"; name: string }
type SemanticMethodDeclaration = { type: "method"; name: string }

type LUT<T> = Record<string, T>

function takeWhile<T>(items: T[], predicate: (item: T) => boolean): T[] {
  const result = []
  for (const item of items) {
    if (predicate(item)) {
      result.push(item)
    } else {
      break
    }
  }
  return result
}

export function partition<T, N extends T>(
  it: Iterable<T>,
  pred: (x: T) => x is N
): [N[], Exclude<T, N>[]]
export function partition<T>(it: Iterable<T>, pred: (x: T) => boolean): [T[], T[]]
export function partition<T>(it: Iterable<T>, pred: (x: T) => boolean): [T[], T[]] {
  const good = []
  const bad = []

  for (const item of it) {
    if (pred(item)) {
      good.push(item)
    } else {
      bad.push(item)
    }
  }

  return [good, bad]
}

const grammar = ohm.grammar(String.raw`
    AstGeneratorGrammar {
      Start = Settings? SemanticDeclaration* Def+

      // Override Ohm's built-in definition of space
      space := "\u0000".." " | comment
      comment = "#" (~"\n" any)*
      wordchar = alnum | "_"
      identStart = letter | "_"
      nodename (a node name) = upper wordchar*
      identifier (an identifier) = ~keyword identStart wordchar*
      stringLiteral (a string) = doubleQuotedString
      doubleQuotedString = "\"" doubleQuotedStringCont* "\""
      doubleQuotedStringCont
        = "\\" any         -- escaped
        | ~"\"" ~"\n" any  -- content

      // Keywords
      keyword  = settings | semantic | property | method
      settings = "settings" ~wordchar
      semantic = "semantic" ~wordchar
      property = "property" ~wordchar
      method   = "method" ~wordchar

      Settings = settings "{" Assignment* "}"

      Assignment
        = identifier "=" stringLiteral

      SemanticDeclaration
        = SemanticPropertyDeclaration
        | SemanticMethodDeclaration

      SemanticPropertyDeclaration
        = semantic property identifier

      SemanticMethodDeclaration
        = semantic method identifier "(" ")"

      Def
        = NodeDef
        | UnionDef

      NodeDef
        = nodename "{" Field* "}"

      UnionDef
        = nodename "=" "|"? NonemptyListOf<NodeRef, "|">

      Field
        = identifier "?"? ":" RepeatedPattern

      RepeatedPattern
        = TypeRef ("+" | "*")?

      TypeRef
        = BuiltinTSTypeUnion
        | NodeRef

      NodeRef
        = nodename

      BuiltinTSTypeUnion
        = NonemptyListOf<BuiltinType, "|">

      // e.g. \`boolean\`, or \`string | boolean\`, or \`42 | "foo"\`
      BuiltinType
        = TSNativeType | TSLiteralType

      TSNativeType
        = "string"
        | "number"
        | "boolean"

      TSLiteralType
        = "null"
        | doubleQuotedString
        | digit+
    }
  `)

const semantics = grammar.createSemantics()

const EMPTY_SETTINGS: Settings = {
  kind: "Settings",
  assignments: [],
  record: {},
}

semantics.addAttribute<
  | Grammar
  | Settings
  | Assignment
  | SemanticDeclaration
  | NodeDef
  | UnionDef
  | Field
  | RepeatedTypePattern
  | TypePattern
  | BuiltinTS
  | TSNativeType
  | TSLiteralType
  | string
>("ast", {
  nodename(_upper, _wordchar): string { return this.sourceString }, // prettier-ignore
  identifier(_letter, _wordchar): string { return this.sourceString }, // prettier-ignore

  Start(settingsBlock, externalsList, defList): Grammar {
    // Settings
    const settings =
      ((settingsBlock.child(0) as ohm.Node | undefined)?.ast as Settings | undefined) ??
      EMPTY_SETTINGS
    const externals = externalsList.children.map((e) => e.ast as SemanticDeclaration)

    const discriminator = settings.record.discriminator ?? "type"

    // Node definitions
    const defs = defList.children.map((d) => d.ast as Def)
    const unionDefsByName: LUT<UnionDef> = {}
    const nodeDefsByName: LUT<NodeDef> = {}

    for (const def of defs) {
      if (def.kind === "UnionDef") {
        unionDefsByName[def.name] = def
      } else {
        nodeDefsByName[def.name] = def
      }
    }

    return {
      kind: "Grammar",
      settings,

      // The first-defined node in the document is the start node
      startNode: Object.keys(nodeDefsByName)[0]!,
      discriminator,
      externals,

      nodeDefsByName,
      nodeDefinitions: Object.keys(nodeDefsByName)
        .sort()
        .map((name) => nodeDefsByName[name]!),

      unionDefsByName,
      unionDefinitions: Object.keys(unionDefsByName)
        .sort()
        .map((name) => unionDefsByName[name]!),

      // isBuiltinRef(ref) { return ref.kind === "BuiltinTS" },
      isUnionRef(ref) {
        return ref.kind === "NodeRef" && unionDefsByName[ref.name] !== undefined
      },
    }
  },

  SemanticPropertyDeclaration(_e, _p, identifier): SemanticPropertyDeclaration {
    return { type: "property", name: identifier.ast as string }
  },

  SemanticMethodDeclaration(_e, _m, identifier, _lp, _rp): SemanticMethodDeclaration {
    return { type: "method", name: identifier.ast as string }
  },

  Settings(_kw, _lb, assignmentList, _rb): Settings {
    const assignments = assignmentList.children.map((a) => a.ast as Assignment)
    const record = Object.fromEntries(assignments.map((a) => [a.key, a.value]))
    return {
      kind: "Settings",
      assignments,
      record,
    }
  },

  Assignment(settingName, _eq, quotedName): Assignment {
    return {
      kind: "Assignment",
      key: settingName.sourceString,
      value: quotedName.ast as string,
    }
  },

  doubleQuotedString(_lq, _content, _rq): string {
    return (
      this.sourceString
        .slice(1, -1)

        // Escaping replaces special characters
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\r/g, "\r")

        // But escaping any other non-special char just keeps it literally
        .replace(/\\(.)/g, "$1")
    )
  },

  NodeDef(name, _lbracket, fieldList, _rbracket): NodeDef {
    const fields = fieldList.children.map((f) => f.ast as Field)
    const fieldsByName = index(fields, (f) => f.name)
    return {
      kind: "NodeDef",
      name: name.ast as string,
      fieldsByName,
      fields,
    }
  },

  UnionDef(name, _eq, _pipe, memberList): UnionDef {
    return {
      kind: "UnionDef",
      name: name.ast as string,
      members: memberList.asIteration().children.map((m) => m.ast as NodeRef),
    }
  },

  Field(name, qmark, _colon, patternNode): Field {
    let pattern: TypePattern = patternNode.ast as RepeatedTypePattern
    if (qmark.children.length > 0) {
      pattern = { kind: "Optional", of: pattern }
    }
    return { kind: "Field", name: name.ast as string, pattern }
  },

  RepeatedPattern(refNode, multiplier): RepeatedTypePattern {
    let ref: RepeatedTypePattern = refNode.ast as TypeRef
    if (multiplier.children.length > 0) {
      const op = multiplier.children[0]!.sourceString
      ref = { kind: "List", of: ref, min: op === "+" ? 1 : 0 }
    }
    return ref
  },

  NodeRef(nodename): NodeRef {
    return { kind: "NodeRef", name: nodename.ast as string }
  },

  BuiltinTSTypeUnion(list): BuiltinTS {
    return {
      kind: "BuiltinTS",
      types: list.asIteration().children.map((child) => child.ast as TSNativeType),
    }
  },

  TSNativeType(type): TSNativeType {
    return {
      kind: "TSNativeType",
      typeName: type.sourceString as TSNativeType["typeName"],
    }
  },

  TSLiteralType(type): TSLiteralType {
    return {
      kind: "TSLiteralType",
      constant: JSON.parse(type.sourceString) as string | number,
    }
  },
})

semantics.addOperation<ohm.Node[]>("allRefs", {
  _terminal() {
    return []
  },
  _nonterminal(...children) {
    return children.flatMap((c) => (c.allRefs as () => ohm.Node[])())
  },
  _iter(...children) {
    return children.flatMap((c) => (c.allRefs as () => ohm.Node[])())
  },
  NodeRef(_nodename) {
    return [this]
  },
})

const KNOWN_SETTINGS = ["output", "discriminator"]

semantics.addOperation<undefined>("check", {
  Settings(_kw, _lb, assignmentList, _rb): undefined {
    for (const assignmentNode of assignmentList.children) {
      const { key } = assignmentNode.ast as Assignment
      if (!KNOWN_SETTINGS.includes(key)) {
        throw new Error(
          assignmentNode.child(0).source.getLineAndColumnMessage() +
            `Unknown setting '${key}'. Supported settings are: ${KNOWN_SETTINGS.map((s) => `'${s}'`).join(", ")}`
        )
      }
    }
  },

  Start(settings, externalDecls, defList): undefined {
    // This is literally the worst way to write `settings?.check()` ever
    ;((settings.child(0) as ohm.Node | undefined)?.check as (() => void) | undefined)?.()

    {
      const seen = new Set()
      for (const decl of externalDecls.children) {
        const astNode = decl.ast as SemanticDeclaration
        if (seen.has(astNode.name)) {
          throw new Error(
            decl.source.getLineAndColumnMessage() +
              `Duplicate semantic declaration of '${astNode.name}'`
          )
        }
        seen.add(astNode.name)
      }
    }

    const validNames = new Set<string>()
    const defs: (NodeDef | UnionDef)[] = []

    // Do a pass over all defined nodes
    for (const def of defList.children) {
      const astNode = def.ast as Def
      if (validNames.has(astNode.name)) {
        throw new Error(
          def.source.getLineAndColumnMessage() +
            `Duplicate definition of '${astNode.name}'`
        )
      }

      validNames.add(astNode.name)
      defs.push(astNode)
    }

    // Do a pass over all node references
    const declaredNames = defs.map((d) => d.name)

    const unused = new Set(validNames)

    // Remove the start node's name
    unused.delete((this.ast as Grammar).startNode)

    for (const ohmNode of (this.allRefs as () => ohm.Node[])()) {
      const nodeRef = ohmNode.ast as NodeRef
      unused.delete(nodeRef.name)

      // Check that all node refs are valid
      if (!declaredNames.includes(nodeRef.name)) {
        throw new Error(
          ohmNode.source.getLineAndColumnMessage() + `Cannot find '${nodeRef.name}'`
        )
      }
    }

    if (unused.size > 0) {
      const [first] = unused
      const name = first!
      const def = defList.children.find((def) => (def.ast as Def).name === name)!
      throw new Error(
        def.children[0]!.source.getLineAndColumnMessage() + `Unused definition '${name}'`
      )
    }
  },
})

function lowercaseFirst(text: string): string {
  return text[0]!.toLowerCase() + text.slice(1)
}

/**
 * Given a NodeRef instance, returns its formatted string, e.g. "MyNode*"
 */
function serializeRef(pat: TypePattern): string {
  if (pat.kind === "Optional") {
    return serializeRef(pat.of) + "?"
  } else if (pat.kind === "List") {
    const base = serializeRef(pat.of)
    if (pat.min > 0) {
      return base + "+"
    } else {
      return base + "*"
    }
  } else if (pat.kind === "NodeRef") {
    return pat.name
  } else {
    return pat.types
      .map((builtin) =>
        builtin.kind === "TSNativeType"
          ? builtin.typeName
          : JSON.stringify(builtin.constant)
      )
      .join(" | ")
  }
}

function getNodeRef(pat: TypePattern): TypeRef {
  return pat.kind === "Optional"
    ? getNodeRef(pat.of)
    : pat.kind === "List"
      ? getNodeRef(pat.of)
      : pat
}

function getBareNodeRef(pat: TypePattern): string | undefined {
  return pat.kind === "Optional"
    ? getBareNodeRef(pat.of)
    : pat.kind === "List"
      ? getBareNodeRef(pat.of)
      : pat.kind === "NodeRef"
        ? pat.name
        : undefined
}

function isBuiltinTypeRef(ref: TypeRef): ref is BuiltinTS {
  return ref.kind === "BuiltinTS"
}

function isNodeRef(ref: TypeRef): ref is NodeRef {
  return ref.kind === "NodeRef"
}

function getTypeScriptType(pat: TypePattern): string {
  return pat.kind === "Optional"
    ? `(${getTypeScriptType(pat.of)}) | null`
    : pat.kind === "List"
      ? `(${getTypeScriptType(pat.of)})[]`
      : isBuiltinTypeRef(pat)
        ? pat.types
            .map((builtin) =>
              builtin.kind === "TSNativeType"
                ? builtin.typeName
                : JSON.stringify(builtin.constant)
            )
            .join(" | ")
        : pat.name
}

function validate(grammar: Grammar) {
  // Ensure discriminator is a valid identifier
  invariant(
    /^[a-z_]\w*$/i.test(grammar.discriminator),
    `Discriminator '${grammar.discriminator}' should be valid JavaScript identifier`
  )

  // Keep track of which node/union names are referenced/used
  const referenced = new Set<string>()

  for (const unionDef of grammar.unionDefinitions) {
    for (const member of unionDef.members) {
      referenced.add(member.name)
      invariant(
        grammar.nodeDefsByName[member.name] ??
          (unionDef.name !== member.name && !!grammar.unionDefsByName[member.name]),
        `Member "${member.name}" of union "${unionDef.name}" is not defined in the grammar`
      )
    }
  }

  const semanticFields = [...grammar.externals.map((ext) => ext.name)]

  for (const node of grammar.nodeDefinitions) {
    for (const field of node.fields) {
      invariant(
        field.name !== grammar.discriminator,
        `Field '${node.name}.${field.name}' conflicts with built-in discriminator field`
      )
      invariant(
        field.name !== "range",
        `Field '${node.name}.${field.name}' conflicts with built-in range property`
      )
      invariant(
        !semanticFields.includes(field.name),
        `Field '${node.name}.${field.name}' conflicts with semantic property/method`
      )

      const bare = getBareNodeRef(field.pattern)
      if (bare === undefined) continue

      const base = getNodeRef(field.pattern)
      referenced.add(bare)
      invariant(
        isBuiltinTypeRef(base) ||
          !!grammar.unionDefsByName[bare] ||
          !!grammar.nodeDefsByName[bare],
        `Unknown node kind "${bare}" (in "${node.name}.${field.name}")`
      )
    }
  }

  // Check that all defined nodes are referenced
  const unreferenced = new Set(grammar.nodeDefinitions.map((n) => n.name))
  for (const name of referenced) {
    unreferenced.delete(name)
  }

  unreferenced.delete(grammar.startNode)
  invariant(
    unreferenced.size === 0,
    `The following node kinds are never referenced: ${Array.from(unreferenced).join(
      ", "
    )}`
  )
}

function generateAssertParam(
  fieldName: string, // actualKindValue
  fieldPat: TypePattern, // expectedNode
  currentContext: string,
  discriminator: string
): string {
  return `assert(${generateTypeCheckCondition(
    fieldPat,
    fieldName,
    discriminator
  )}, \`Invalid value for "${fieldName}" arg in ${JSON.stringify(
    currentContext
  )} call.\\nExpected: ${serializeRef(
    fieldPat
  )}\\nGot:      \${JSON.stringify(${fieldName})}\`)`
}

function generateTypeCheckCondition(
  expected: TypePattern,
  actualValue: string,
  discriminator: string
): string {
  const conditions = []

  if (expected.kind === "Optional") {
    conditions.push(
      `${actualValue} === null || ${generateTypeCheckCondition(expected.of, actualValue, discriminator)}`
    )
  } else if (expected.kind === "List") {
    conditions.push(`Array.isArray(${actualValue})`)
    if (expected.min > 0) {
      conditions.push(`${actualValue}.length > 0`)
    }
    conditions.push(
      `${actualValue}.every(item => ${generateTypeCheckCondition(expected.of, "item", discriminator)})`
    )
  } else if (expected.kind === "NodeRef") {
    conditions.push(`is${expected.name}(${actualValue})`)
  } else if (isBuiltinTypeRef(expected)) {
    conditions.push(
      `( ${expected.types
        .map((builtin) => {
          if (builtin.kind === "TSNativeType") {
            return `typeof ${actualValue} === ${JSON.stringify(builtin.typeName)}`
          } else {
            return `${actualValue} === ${JSON.stringify(builtin.constant)}`
          }
        })
        .join(" || ")})`
    )
  }

  return conditions.map((c) => `(${c})`).join(" && ")
}

const onlyOnce = new WeakSet()

function generateCommonSemanticHelpers(grammar: Grammar): string {
  if (onlyOnce.has(generateCommonSemanticHelpers)) return ""
  onlyOnce.add(generateCommonSemanticHelpers)

  return `
    export type SemanticProperty = ${
      grammar.externals
        .filter((ext) => ext.type === "property")
        .map((ext) => JSON.stringify(ext.name))
        .join(" | ") || "never"
    }
    export type SemanticMethod = ${
      grammar.externals
        .filter((ext) => ext.type === "method")
        .map((ext) => JSON.stringify(ext.name))
        .join(" | ") || "never"
    }

    type UserDefinedReturnType<K extends SemanticProperty | SemanticMethod> =
      K extends keyof Semantics
        ? (
            Semantics[K] extends (...args: any[]) => infer R
            ? R
            : (
                Semantics[K] extends infer UP
                  ? UP
                  : never
              )
          )
        : never

    type UserDefinedContext<K extends SemanticProperty | SemanticMethod> =
      K extends keyof Semantics
        ? (
            Semantics[K] extends (context: infer C, ...rest: any[]) => any
              ? C
              : undefined
          )
        : never

    export interface ExhaustiveDispatchMap<T, C> {
      ${grammar.nodeDefinitions
        .map((node) => `  ${node.name}(node: ${node.name}, context: C): T;`)
        .join("\n")}
    }

    type DispatchFn<T, C> = (node: Node, context: C) => T;

    interface PartialDispatchMap<T, C> extends Partial<ExhaustiveDispatchMap<T, C>> {
      beforeEach?(node: Node, context: C): void;
      afterEach?(node: Node, context: C): void;

      Node?(node: Node, context: C): T;${
        /*
        // TODO Maybe also allow "Expr" rule as fallback for unions? If so, how to
        // handle it when a node type is part of multiple unions?',
      */ ""
      }
    }

    export type PartialDispatcher<T, C> = PartialDispatchMap<T, C> | DispatchFn<T, C>;

    const NOT_IMPLEMENTED = Symbol();

    ${
      grammar.externals.length > 0
        ? `
          const stub = (msg: string) => {
            return Object.defineProperty((_node: Node, _context: any): any => {
              throw new Error(msg)
            }, NOT_IMPLEMENTED, { value: NOT_IMPLEMENTED, enumerable: false })
          }
      `
        : ""
    }
    ${
      grammar.externals.some((ext) => ext.type === "property")
        ? `
            const pStub = (name: string) =>
              stub(\`Semantic property '\${name}' is not defined yet. Use 'defineProperty(\${JSON.stringify(name)}, { ... })' before accessing '.\${name}' on a node.\`)
          `
        : ""
    }
    ${
      grammar.externals.some((ext) => ext.type === "method")
        ? `
            const mStub = (name: string) =>
              stub(\`Semantic method '\${name}' is not defined yet. Use 'defineMethod(\${JSON.stringify(name)}, { ... })' before calling '.\${name}()' on a node.\`)
          `
        : ""
    }

    const semantics = {
      ${grammar.externals
        .map(
          (ext) =>
            `${JSON.stringify(ext.name)}: ${ext.type === "property" ? "pStub" : "mStub"}(${JSON.stringify(ext.name)}),`
        )
        .join("\n")}
    }

    function dispatch<
      K extends SemanticProperty | SemanticMethod,
      N extends Node,
      R = UserDefinedReturnType<K>,
      C = UserDefinedContext<K>
    >(
      name: K,
      node: N,
      dispatcher: PartialDispatcher<R, C>,
      context: C,
    ): R {
      const handler = typeof dispatcher === 'function' ? dispatcher : dispatcher[node.${grammar.discriminator}] ?? dispatcher.Node;

      if (handler === undefined) {
        throw new Error(\`Semantic '\${name}' is only partially defined and missing definition for '\${node.${grammar.discriminator}}'\`);
      }

      if (typeof dispatcher !== 'function') dispatcher.beforeEach?.(node, context)
      const rv = handler(node as never, context)
      if (typeof dispatcher !== 'function') dispatcher.afterEach?.(node, context)
      return rv
    }
  `
}

function generateMethodHelpers(grammar: Grammar): string {
  const methods = grammar.externals.filter((ext) => ext.type === "method")
  if (methods.length === 0) {
    return ""
  }

  return `
    ${generateCommonSemanticHelpers(grammar)}

    export function defineMethod<
      M extends SemanticMethod,
      R = UserDefinedReturnType<M>,
      C = UserDefinedContext<M>,
    >(name: M, dispatcher: PartialDispatcher<R, C>): void {
      if (!semantics.hasOwnProperty(name)) {
        const err = new Error(\`Unknown semantic method '\${name}'. Did you forget to add 'semantic method \${name}()' in your grammar?\`)
        Error.captureStackTrace(err, defineMethod)
        throw err
      }

      if (!(NOT_IMPLEMENTED in semantics[name])) {
        const err = new Error(\`Semantic method '\${name}' is already defined\`)
        Error.captureStackTrace(err, defineMethod)
        throw err
      }

      semantics[name] =
        ((node: Node, context: C) => dispatch(name, node, dispatcher, context))
    }

    export function defineMethodExhaustively<
      M extends SemanticMethod,
      R = UserDefinedReturnType<M>,
      C = UserDefinedContext<M>,
    >(
      name: M,
      dispatcher: ExhaustiveDispatchMap<R, C>,
    ): void {
      return defineMethod(name, dispatcher);
    }
  `
}

function generatePropertyHelpers(grammar: Grammar): string {
  const props = grammar.externals.filter((ext) => ext.type === "property")
  if (props.length === 0) {
    return ""
  }

  return `
    ${generateCommonSemanticHelpers(grammar)}

    export function defineProperty<
      P extends SemanticProperty,
      R = UserDefinedReturnType<P>
    >(
      name: P,
      dispatcher: PartialDispatcher<R, undefined>,
    ): void {
      if (!semantics.hasOwnProperty(name)) {
        const err = new Error(\`Unknown semantic property '\${name}'. Did you forget to add 'semantic property \${name}' in your grammar?\`)
        Error.captureStackTrace(err, defineProperty)
        throw err
      }

      if (!(NOT_IMPLEMENTED in semantics[name])) {
        const err = new Error(\`Semantic property '\${name}' is already defined\`)
        Error.captureStackTrace(err, defineProperty)
        throw err
      }

      semantics[name] = (node: Node) => dispatch(name, node, dispatcher, undefined);
    }

    export function definePropertyExhaustively<
      P extends SemanticProperty,
      R extends UserDefinedReturnType<P>
    >(
      name: P,
      dispatcher: ExhaustiveDispatchMap<R, undefined>,
    ): void {
      return defineProperty(name, dispatcher);
    }
  `
}

function parseGrammarFromPath(path: string): Grammar {
  const src = fs.readFileSync(path, "utf-8")
  return parseGrammarFromString(src)
}

function index<T>(arr: T[], keyFn: (item: T) => string): LUT<T> {
  const result: LUT<T> = {}
  for (const item of arr) {
    result[keyFn(item)] = item
  }
  return result
}

export function parseGrammarFromString(text: string): Grammar {
  const parsed = grammar.match(text)
  if (parsed.message) {
    throw new Error(parsed.message)
  }

  const tree = semantics(parsed)
  ;(tree.check as () => void)() // Will throw in case of errors
  return tree.ast as Grammar
}

function generateCode(grammar: Grammar): string {
  // Will throw in case of errors
  validate(grammar)

  const output = [
    "//",
    "// This file is GENERATED by ast-generator",
    "// DO NOT edit this file manually.",
    "//",
    "// Instead, update the `ast.grammar` file, and regenerate this file.",
    "//",
    "/* eslint-disable */",
    "",
    `

    /**
     * Intended to augment by end users.
     *
     * See https://github.com/nvie/ast-generator/blob/main/README.md#assigning-semantic-meaning-to-nodes
     */
    export interface Semantics { }

    type BuiltinNodeProps = "children" | "descendants"

    const DEBUG = process.env.NODE_ENV !== 'production';

    function assert(condition: boolean, errmsg: string): asserts condition {
      if (condition) return;
      throw new Error(errmsg);
    }

    const _nodes = new WeakSet()

    function method<T, A extends any[]>(impl: (...args: A) => T) { return { enumerable: false, value: impl } }
    function getter<T>(impl: () => T) { return { enumerable: false, get: impl } }

    function createNode<N extends Node>(base: Omit<N, keyof Semantics | BuiltinNodeProps>): N {
      const node = base as N;

      ${
        !grammar.externals.some((ext) => ext.type === "property")
          ? ""
          : `
              const pcache = new Map()
              const semanticProp = (key: SemanticProperty) => getter(() => {
                if (pcache.has(key)) return pcache.get(key);
                const value = semantics[key](node, undefined);
                pcache.set(key, value);
                return value;
              })
            `
      }

      ${
        !grammar.externals.some((ext) => ext.type === "method")
          ? ""
          : `
              const semanticMeth = (key: SemanticMethod) => method((context) => semantics[key](node, context))
            `
      }

      Object.defineProperties(base, {
        range: { enumerable: false },
        children: getter(() => iterChildren(node)),
        descendants: getter(() => iterDescendants(node)),

        ${grammar.externals
          .filter((ext) => ext.type === "property")
          .map(
            (ext) =>
              `${JSON.stringify(ext.name)}: semanticProp(${JSON.stringify(ext.name)}),`
          )
          .join("\n")}
        ${grammar.externals
          .filter((ext) => ext.type === "method")
          .map(
            (ext) =>
              `${JSON.stringify(ext.name)}: semanticMeth(${JSON.stringify(ext.name)}),`
          )
          .join("\n")}
      })

      _nodes.add(node)
      return node
    }

    `,
  ]

  for (const union of grammar.unionDefinitions) {
    const [subUnions, subNodes] = partition(union.members, (m) => grammar.isUnionRef(m))
    const conditions = subNodes
      .map((ref) => `value.${grammar.discriminator} === ${JSON.stringify(ref.name)}`)
      .concat(subUnions.map((ref) => `is${ref.name}(value)`))
    output.push(`
      export function is${union.name}(value: unknown): value is ${union.name} {
        return isNode(value) && (${conditions.join(" || ")})
      }
    `)
  }

  for (const union of grammar.unionDefinitions) {
    output.push(`
      export type ${union.name} =
        ${union.members.map((member) => member.name).join(" | ")};
    `)
  }

  output.push(`
    ${generateMethodHelpers(grammar)}
    ${generatePropertyHelpers(grammar)}

    export type Node = ${grammar.nodeDefinitions.map((node) => node.name).join(" | ")}

    export type ChildrenOf<N extends Node> = {
      ${grammar.nodeDefinitions
        .map((node) => {
          const nodeType = node.name
          const childTypes = new Set(
            node.fields
              .map((f) => getNodeRef(f.pattern))
              .filter(isNodeRef)
              .map((ref) => ref.name)
          )
          return `${JSON.stringify(nodeType)}: ${[...childTypes].join(" | ") || "never"},`
        })
        .join("\n")}
    }[N[${JSON.stringify(grammar.discriminator)}]];

    // TODO Define this more elegantly later
    export type DescendantsOf<N extends Node> =
      | ChildrenOf<N>
      | ChildrenOf<ChildrenOf<N>>
      | ChildrenOf<ChildrenOf<ChildrenOf<N>>>
      | ChildrenOf<ChildrenOf<ChildrenOf<ChildrenOf<N>>>>
      | ChildrenOf<ChildrenOf<ChildrenOf<ChildrenOf<ChildrenOf<N>>>>>
      | ChildrenOf<ChildrenOf<ChildrenOf<ChildrenOf<ChildrenOf<ChildrenOf<N>>>>>>

    export type Range = [number, number]

    export function isRange(thing: unknown): thing is Range {
      return (
        Array.isArray(thing)
        && thing.length === 2
        && typeof thing[0] === 'number'
        && typeof thing[1] === 'number'
      )
    }

    function assertRange(range: unknown, currentContext: string): asserts range is Range {
      assert(
        isRange(range),
        \`Invalid value for range in "\${JSON.stringify(currentContext)}".\\nExpected: Range\\nGot: \${JSON.stringify(range)}\`
      );
    }

    export function isNode(value: unknown): value is Node {
      return _nodes.has(value as Node)
    }
  `)

  for (const node of grammar.nodeDefinitions) {
    output.push(`
      export interface ${node.name} extends Semantics {
          ${grammar.discriminator}: ${JSON.stringify(node.name)}
          ${node.fields
            .map((field) => `${field.name}: ${getTypeScriptType(field.pattern)}`)
            .join("\n")}
          range: Range;
          children: IterableIterator<ChildrenOf<${node.name}>>;
          descendants: IterableIterator<DescendantsOf<${node.name}>>;
      }
    `)

    output.push(`
      export function is${node.name}(value: unknown): value is ${node.name} {
        return isNode(value) && (value.${grammar.discriminator} === ${JSON.stringify(
          node.name
        )})
      }
    `)
  }

  output.push("")
  for (const node of grammar.nodeDefinitions) {
    const optionals = new Set(
      takeWhile(
        node.fields.slice().reverse(),
        (field) =>
          field.pattern.kind === "Optional" ||
          (field.pattern.kind === "List" && field.pattern.min === 0)
      ).map((field) => field.name)
    )

    const runtimeTypeChecks = node.fields.map((field) =>
      generateAssertParam(field.name, field.pattern, node.name, grammar.discriminator)
    )
    runtimeTypeChecks.push(`assertRange(range, ${JSON.stringify(node.name)})`)

    output.push(`
      export function ${lowercaseFirst(node.name)}(${[
        ...node.fields.map((field) => {
          const key = field.name
          const type = getTypeScriptType(field.pattern)
          return optionals.has(field.name)
            ? `${key}: ${type} = ${field.pattern.kind === "Optional" ? "null" : "[]"}`
            : `${key}: ${type}`
        }),
        "range: Range = [0, 0]",
      ].join(", ")}): ${node.name} {
        ${
          runtimeTypeChecks.length > 0
            ? `DEBUG && (() => { ${runtimeTypeChecks.join("\n")} })()`
            : ""
        }
        return createNode({
            ${grammar.discriminator}: ${JSON.stringify(node.name)},
            ${[...node.fields.map((field) => field.name), "range"].join(", ")}
        });
      }
    `)
  }

  output.push(`
    function* iterChildren<N extends Node>(node: N): IterableIterator<ChildrenOf<N>> {
      switch (node.${grammar.discriminator}) {
  `)

  for (const node of grammar.nodeDefinitions) {
    const fields = node.fields.filter(
      (field) => !isBuiltinTypeRef(getNodeRef(field.pattern))
    )

    if (fields.length === 0) {
      continue
    }

    output.push("")
    output.push(`case ${JSON.stringify(node.name)}:`)
    for (const field of fields) {
      switch (field.pattern.kind) {
        case "NodeRef":
          output.push(`  yield node.${field.name} as ChildrenOf<N>`)
          break

        case "List":
          output.push(`  for (const child of node.${field.name}) {`)
          output.push("    yield child as ChildrenOf<N>")
          output.push("  }")
          break

        case "Optional":
          output.push(
            `  // TODO: Implement visiting for _optional_ field node.${field.name}`
          )
          break
      }
    }
    output.push("  break;")
  }

  output.push(`
      }
    }
  `)

  output.push(`
    function* iterDescendants<N extends Node>(node: N): IterableIterator<DescendantsOf<N>> {
      // Perform breadth-first traversal, not depth-first
      const queue: Node[] = [node]
      while (true) {
        const current = queue.shift()
        if (current === undefined) break;  // Done

        yield current as DescendantsOf<N>
        for (const child of iterChildren(current)) {
          queue.push(child)
        }
      }
    }
  `)

  return output.join("\n")
}

function writeFile(contents: string, path: string) {
  const existing = fs.existsSync(path)
    ? fs.readFileSync(path, { encoding: "utf-8" })
    : null
  if (contents !== existing) {
    fs.writeFileSync(path, contents, { encoding: "utf-8" })
    console.error(`Wrote ${path}`)
  } else {
    // Output file is still up to date, let's not write (since it may
    // trigger another watch proc)
    console.error(`Skipped ${path} (up to date)`)
  }
}

export async function generateAST(inpath: string): Promise<void> {
  const grammar = parseGrammarFromPath(inpath)
  const uglyCode = generateCode(grammar)

  // Output file is relative. Generated it relative to the inpath
  const output = grammar.settings.record.output ?? "generated-ast.ts"
  const outpath = pathLib.join(pathLib.dirname(inpath), output)

  // Beautify it with prettier
  const config = await prettier.resolveConfig(outpath)
  if (config === null) {
    throw new Error("Could not find or read .prettierrc config for this project")
  }

  const code = await prettier.format(uglyCode, {
    ...config,
    parser: "typescript",
  })
  writeFile(code, outpath)
}
