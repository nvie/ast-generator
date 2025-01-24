import fs from "fs"
import * as ohm from "ohm-js"
import prettier from "prettier"
import invariant from "tiny-invariant"

const TYPEOF_CHECKS = new Set(["number", "string", "boolean"])

function isBuiltInType(ref: AGNodeRef): ref is BuiltinType {
  return ref.ref === "Raw"
}

type BuiltinType = { ref: "Raw"; name: string }

// e.g. "MyNode" or "@MyUnion"
type AGNodeRef =
  | BuiltinType // e.g. `boolean`, or `string | boolean`
  | { ref: "Node"; name: string }
  | { ref: "NodeUnion"; name: string }

// e.g. "MyNode+" or "@MyUnion*"
type AGRepeatedPattern =
  | AGNodeRef
  | {
      ref: "List"
      of: AGNodeRef
      min: 0 | 1
    }

// e.g. "MyNode?" or "@MyUnion*?"
type AGPattern =
  | AGRepeatedPattern
  | {
      ref: "Optional"
      of: AGRepeatedPattern
    }

// e.g. ['FloatLiteral', 'IntLiteral', '@StringExpr']
type AGUnionDef = {
  name: string
  members: AGPattern[]
}

type AGField = {
  name: string
  pattern: AGPattern
}

type AGNodeDef = {
  name: string
  fieldsByName: LUT<AGField>
  fields: AGField[]
}

type AGExternalDefinition = AGExternalProperty | AGExternalMethod
type AGExternalProperty = { type: "property"; name: string }
type AGExternalMethod = { type: "method"; name: string }

type AGDef = AGUnionDef | AGNodeDef

type LUT<T> = Record<string, T>

type AGGrammar = {
  externals: AGExternalDefinition[]
  startNode: string

  nodesByName: LUT<AGNodeDef>
  nodes: AGNodeDef[] // Sorted list of nodes

  unionsByName: LUT<AGUnionDef>
  unions: AGUnionDef[] // Sorted list of node unions
}

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

function partition<T>(items: T[], predicate: (item: T) => boolean): [T[], T[]] {
  const gold: T[] = []
  const dirt: T[] = []
  for (const item of items) {
    if (predicate(item)) {
      gold.push(item)
    } else {
      dirt.push(item)
    }
  }
  return [gold, dirt]
}

const grammar = ohm.grammar(String.raw`
    AstGeneratorGrammar {
      Start = ExternalDeclaration* Def+

      // Override Ohm's built-in definition of space
      space := "\u0000".." " | comment
      comment = "#" (~"\n" any)*
      nodename (a node name) = upper alnum*
      identifier (an identifier) = ~keyword letter alnum*

      // Keywords
      keyword = external | property | method
      external = "external" ~alnum
      property = "property" ~alnum
      method   = "method" ~alnum

      ExternalDeclaration
        = ExternalPropertyDeclaration
        | ExternalMethodDeclaration

      ExternalPropertyDeclaration
        = "external" "property" identifier

      ExternalMethodDeclaration
        = "external" "method" identifier "(" ")"

      Def
        = AGNodeDef
        | AGUnionDef

      AGNodeDef
        = nodename "{" AGField* "}"

      AGUnionDef
        = "@" nodename "=" "|"? NonemptyListOf<AGNodeRef, "|">

      AGField
        = identifier "?"? ":" AGRepeatedPattern

      AGRepeatedPattern
        = AGNodeRef ("+" | "*")?

      AGNodeRef
        = BuiltinTypeUnion  -- builtin
        | nodename          -- node
        | "@" nodename      -- union

      BuiltinTypeUnion
        = NonemptyListOf<BuiltinType, "|">

      // e.g. \`boolean\`, or \`string | boolean\`
      BuiltinType
        = "string"
        | "number"
        | "boolean"
        | "null"
    }
  `)

const semantics = grammar.createSemantics()

semantics.addAttribute<
  | AGGrammar
  | AGExternalDefinition
  | AGNodeDef
  | AGUnionDef
  | AGField
  | AGRepeatedPattern
  | AGPattern
  | BuiltinType
  | string
>("ast", {
  nodename(_upper, _alnum): string { return this.sourceString }, // prettier-ignore
  identifier(_letter, _alnum): string { return this.sourceString }, // prettier-ignore

  Start(externalDecls, defList): AGGrammar {
    const externals = externalDecls.children.map((d) => d.ast as AGExternalDefinition)

    const defs = defList.children.map((d) => d.ast as AGDef)

    const unionsByName: LUT<AGUnionDef> = {}
    const nodesByName: LUT<AGNodeDef> = {}

    for (const def of defs) {
      if ("members" in def) {
        unionsByName[def.name] = def
      } else {
        nodesByName[def.name] = def
      }
    }

    return {
      externals,

      // The first-defined node in the document is the start node
      startNode: Object.keys(nodesByName)[0]!,

      nodesByName,
      nodes: Object.keys(nodesByName)
        .sort()
        .map((name) => nodesByName[name]!),

      unionsByName,
      unions: Object.keys(unionsByName)
        .sort()
        .map((name) => unionsByName[name]!),
    }
  },

  ExternalPropertyDeclaration(_e, _p, identifier): AGExternalProperty {
    return { type: "property", name: identifier.ast as string }
  },

  ExternalMethodDeclaration(_e, _m, identifier, _lp, _rp): AGExternalMethod {
    return { type: "method", name: identifier.ast as string }
  },

  AGNodeDef(name, _lbracket, fieldList, _rbracket): AGNodeDef {
    const fields = fieldList.children.map((f) => f.ast as AGField)
    const fieldsByName = index(fields, (f) => f.name)
    return {
      name: name.ast as string,
      fieldsByName,
      fields,
    }
  },

  AGUnionDef(_at, name, _eq, _pipe, memberList): AGUnionDef {
    return {
      name: name.ast as string,
      members: memberList.asIteration().children.map((m) => m.ast as AGPattern),
    }
  },

  AGField(name, qmark, _colon, patternNode): AGField {
    let pattern: AGPattern = patternNode.ast as AGRepeatedPattern
    if (qmark.children.length > 0) {
      pattern = { ref: "Optional", of: pattern }
    }
    return { name: name.ast as string, pattern }
  },

  AGRepeatedPattern(refNode, multiplier): AGRepeatedPattern {
    let ref: AGRepeatedPattern = refNode.ast as AGNodeRef
    if (multiplier.children.length > 0) {
      const op = multiplier.children[0]!.sourceString
      ref = { ref: "List", of: ref, min: op === "+" ? 1 : 0 }
    }
    return ref
  },

  AGNodeRef_node(nodename): AGNodeRef {
    return { ref: "Node", name: nodename.ast as string }
  },

  AGNodeRef_union(_at, nodename): AGNodeRef {
    return { ref: "NodeUnion", name: nodename.ast as string }
  },

  BuiltinTypeUnion(list): BuiltinType {
    return {
      ref: "Raw",
      name: list.sourceString,
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
  AGNodeRef_node(_nodename) {
    return [this]
  },
  AGNodeRef_union(_at, _nodename) {
    return [this]
  },
})

semantics.addOperation<undefined>("check", {
  Start(externalDecls, defList): undefined {
    {
      const seen = new Set()
      for (const decl of externalDecls.children) {
        const astNode = decl.ast as AGExternalDefinition
        if (seen.has(astNode.name)) {
          throw new Error(
            decl.source.getLineAndColumnMessage() +
              `Duplicate external declaration of '${astNode.name}'`
          )
        }
        seen.add(astNode.name)
      }
    }

    const validNames = new Set<string>()

    const nodeDefs: AGNodeDef[] = []
    const unionDefs: AGUnionDef[] = []

    // Do a pass over all defined nodes
    for (const def of defList.children) {
      const astNode = def.ast as AGDef
      if (validNames.has(astNode.name)) {
        throw new Error(
          def.source.getLineAndColumnMessage() +
            `Duplicate definition of '${astNode.name}'`
        )
      }

      validNames.add(astNode.name)
      if ("members" in astNode) {
        unionDefs.push(astNode)
      } else {
        nodeDefs.push(astNode)
      }
    }

    // Do a pass over all node references
    const nodeNames = nodeDefs.map((d) => d.name)
    const unionNames = unionDefs.map((d) => d.name)

    const unused = new Set(validNames)

    // Remove the start node's name
    unused.delete((this.ast as AGGrammar).startNode)

    for (const ohmNode of (this.allRefs as () => ohm.Node[])()) {
      const nodeRef = ohmNode.ast as AGNodeRef
      unused.delete(nodeRef.name)

      // Check that all MyNode refs are valid
      if (nodeRef.ref === "Node") {
        if (!nodeNames.includes(nodeRef.name)) {
          throw new Error(
            ohmNode.source.getLineAndColumnMessage() + `Cannot find '${nodeRef.name}'`
          )
        }
      }

      // Check that all @MyUnion refs are valid
      if (nodeRef.ref === "NodeUnion") {
        if (!unionNames.includes(nodeRef.name)) {
          throw new Error(
            ohmNode.source.getLineAndColumnMessage() + `Cannot find '@${nodeRef.name}'`
          )
        }
      }
    }

    if (unused.size > 0) {
      const [first] = unused
      const name = first!
      const def = defList.children.find((def) => (def.ast as AGDef).name === name)!
      throw new Error(
        def.children[0]!.source.getLineAndColumnMessage() +
          `Unused definition '${"members" in (def.ast as AGDef) ? "@" : ""}${name}'`
      )
    }
  },
})

function lowercaseFirst(text: string): string {
  return text[0]!.toLowerCase() + text.slice(1)
}

/**
 * Given a NodeRef instance, returns its formatted string, e.g. "@MyNode*"
 */
function serializeRef(pat: AGPattern): string {
  if (pat.ref === "Optional") {
    return serializeRef(pat.of) + "?"
  } else if (pat.ref === "List") {
    const base = serializeRef(pat.of)
    if (pat.min > 0) {
      return base + "+"
    } else {
      return base + "*"
    }
  } else if (pat.ref === "NodeUnion") {
    return "@" + pat.name
  } else if (pat.ref === "Node") {
    return pat.name
  } else {
    return pat.name
  }
}

function getNodeRef(pat: AGPattern): AGNodeRef {
  return pat.ref === "Optional"
    ? getNodeRef(pat.of)
    : pat.ref === "List"
      ? getNodeRef(pat.of)
      : pat
}

function getBareRef(pat: AGPattern): string {
  return pat.ref === "Optional"
    ? getBareRef(pat.of)
    : pat.ref === "List"
      ? getBareRef(pat.of)
      : pat.ref === "Node"
        ? pat.name
        : pat.ref === "NodeUnion"
          ? pat.name
          : pat.name
}

function getBareRefTarget(pat: AGPattern): "Node" | "NodeUnion" | "Raw" {
  return pat.ref === "Optional" || pat.ref === "List" ? getBareRefTarget(pat.of) : pat.ref
}

function getTypeScriptType(pat: AGPattern): string {
  return pat.ref === "Optional"
    ? getTypeScriptType(pat.of) + " | null"
    : pat.ref === "List"
      ? getTypeScriptType(pat.of) + "[]"
      : isBuiltInType(pat)
        ? pat.name
        : pat.name
}

function validate(grammar: AGGrammar) {
  // Keep track of which node names are referenced/used
  const referenced = new Set<string>()

  for (const nodeUnion of grammar.unions) {
    for (const ref of nodeUnion.members) {
      const memberName = getBareRef(ref)
      referenced.add(memberName)
      invariant(
        grammar.nodesByName[memberName] ??
          (nodeUnion.name !== memberName && !!grammar.unionsByName[memberName]),
        `Member "${memberName}" of union "${nodeUnion.name}" is not defined in the grammar`
      )
    }
  }

  for (const node of grammar.nodes) {
    for (const field of node.fields) {
      invariant(
        !field.name.startsWith("_"),
        `Illegal field name: "${node.name}.${field.name}" (fields starting with "_" are reserved)`
      )
      const bare = getBareRef(field.pattern)
      const base = getNodeRef(field.pattern)
      referenced.add(bare)
      invariant(
        isBuiltInType(base) ||
          !!grammar.unionsByName[bare] ||
          !!grammar.nodesByName[bare],
        `Unknown node kind "${bare}" (in "${node.name}.${field.name}")`
      )
    }
  }

  // Check that all defined nodes are referenced
  const unreferenced = new Set(grammar.nodes.map((n) => n.name))
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
  fieldPat: AGPattern, // expectedNode
  currentContext: string
): string {
  return `assert(${generateTypeCheckCondition(
    fieldPat,
    fieldName
  )}, \`Invalid value for "${fieldName}" arg in ${JSON.stringify(
    currentContext
  )} call.\\nExpected: ${serializeRef(
    fieldPat
  )}\\nGot:      \${JSON.stringify(${fieldName})}\`)`
}

function generateTypeCheckCondition(expected: AGPattern, actualValue: string): string {
  const conditions = []

  if (expected.ref === "Optional") {
    conditions.push(
      `${actualValue} === null || ${generateTypeCheckCondition(expected.of, actualValue)}`
    )
  } else if (expected.ref === "List") {
    conditions.push(`Array.isArray(${actualValue})`)
    if (expected.min > 0) {
      conditions.push(`${actualValue}.length > 0`)
    }
    conditions.push(
      `${actualValue}.every(item => ${generateTypeCheckCondition(expected.of, "item")})`
    )
  } else if (expected.ref === "NodeUnion") {
    conditions.push(`is${expected.name}(${actualValue})`)
  } else if (isBuiltInType(expected)) {
    conditions.push(
      `( ${expected.name
        .replace(/`/g, "")
        .split("|")
        .flatMap((part) => {
          part = part.trim()
          if (TYPEOF_CHECKS.has(part)) {
            return [`typeof ${actualValue} === ${JSON.stringify(part)}`]
          } else if (part === "null") {
            return [`${actualValue} === null`]
          } else {
            console.warn(`Cannot emit runtime type check for ${part}`)
            return []
          }
        })
        .join(" || ")})`
    )
  } else {
    conditions.push(`${actualValue}._kind === ${JSON.stringify(expected.name)}`)
  }

  return conditions.map((c) => `(${c})`).join(" && ")
}

const onlyOnce = new WeakSet()

function generateStub(): string {
  if (onlyOnce.has(generateStub)) return ""
  onlyOnce.add(generateStub)
  return `
    const NOT_IMPLEMENTED = Symbol();

    const stub = (msg: string) => {
      return Object.defineProperty((_node: Node): any => {
        throw new Error(msg)
      }, NOT_IMPLEMENTED, { value: NOT_IMPLEMENTED, enumerable: false })
    }
  `
}

function generateMethodHelpers(grammar: AGGrammar): string {
  const methods = grammar.externals.filter((ext) => ext.type === "method")
  if (methods.length === 0) {
    return ""
  }

  const union = methods.map((ext) => JSON.stringify(ext.name)).join(" | ")
  // TODO Would be nice to also allow defineMethod('name', (node) => ...) directly
  // TODO This API would not make sense for defineMethodExhaustively, though
  return `
    ${generateStub()}

    const mStub = (name: string) =>
      stub(\`Semantic method '\${name}' is not defined yet. Use 'defineMethod(\${JSON.stringify(name)}, { ... })' before calling '.\${name}()' on a node.\`)

    const semanticMethods = {
      ${methods
        .map((ext) => `${JSON.stringify(ext.name)}: mStub(${JSON.stringify(ext.name)}),`)
        .join("\n")}
    }

    export function defineMethod<
      M extends ${union},
      R extends ReturnType<Semantics[M]>
    >(name: M, dispatchMap: PartialDispatch<R>): void {
      if (!semanticMethods.hasOwnProperty(name)) {
        const err = new Error(\`Unknown semantic method '\${name}'. Did you forget to add 'external method \${name}()' in your grammar?\`)
        Error.captureStackTrace(err, defineMethod)
        throw err
      }

      // Ensure each semantic method will be defined at most once
      if (!(NOT_IMPLEMENTED in semanticMethods[name])) {
        const err = new Error(\`Semantic method '\${name}' is already defined\`)
        Error.captureStackTrace(err, defineMethod)
        throw err
      }

      semanticMethods[name] = (node: Node) => dispatchMethod(name, node, dispatchMap)
    }

    export function defineMethodExhaustively<
      M extends ${union},
      R extends ReturnType<Semantics[M]>
    >(
      name: M,
      dispatchMap: ExhaustiveDispatch<R>,
    ): void {
      return defineMethod(name, dispatchMap);
    }

    function dispatchMethod<T, TNode extends Node>(
      method: ${union},
      node: TNode,
      dispatchMap: PartialDispatch<T>,
    ): T {
      const handler = dispatchMap[node._kind] ?? dispatchMap.Node;
      if (handler === undefined) {
        const err = new Error(\`Semantic method '\${method}' not defined on '\${node._kind}'\`);
        Error.captureStackTrace(err, dispatchMethod)
        throw err
      }
      return handler(node as never)
    }
  `
}

function generatePropertyHelpers(grammar: AGGrammar): string {
  const props = grammar.externals.filter((ext) => ext.type === "property")
  if (props.length === 0) {
    return ""
  }

  const union = props.map((ext) => JSON.stringify(ext.name)).join(" | ")
  // TODO Would be nice to also allow defineProperty('name', (node) => ...) directly
  // TODO This API would not make sense for definePropertyExhaustively, though
  return `
    ${generateStub()}

    const pStub = (name: string) =>
      stub(\`Semantic property '\${name}' is not defined yet. Use 'defineProperty(\${JSON.stringify(name)}, { ... })' before accessing '.\${name}' on a node.\`)

    const semanticPropertyFactories = {
      ${props
        .map((ext) => `${JSON.stringify(ext.name)}: pStub(${JSON.stringify(ext.name)}),`)
        .join("\n")}
    }

    const memoedSemanticProperties = {
      ${props.map((ext) => `${JSON.stringify(ext.name)}: new WeakMap(),`).join("\n")}
    }

    export function defineProperty<
      P extends ${union},
      R extends Semantics[P]
    >(
      name: P,
      dispatchMap: PartialDispatch<R>,
    ): void {
      if (!semanticPropertyFactories.hasOwnProperty(name)) {
        const err = new Error(\`Unknown semantic property '\${name}'. Did you forget to add 'external property \${name}' in your grammar?\`)
        Error.captureStackTrace(err, defineProperty)
        throw err
      }

      // Ensure each semantic property will be defined at most once
      if (!(NOT_IMPLEMENTED in semanticPropertyFactories[name])) {
        const err = new Error(\`Semantic property '\${name}' is already defined\`)
        Error.captureStackTrace(err, defineProperty)
        throw err
      }

      // TODO We can probably DRY a bunch of stuff up in here
      semanticPropertyFactories[name] = (node: Node) => {
        const cache = memoedSemanticProperties[name]
        if (cache.has(node)) return cache.get(node)
        const rv = dispatchProperty(name, node, dispatchMap)
        cache.set(node, rv)
        return rv
      }
    }

    export function definePropertyExhaustively<
      P extends ${union},
      R extends Semantics[P]
    >(
      name: P,
      dispatchMap: ExhaustiveDispatch<R>,
    ): void {
      return defineProperty(name, dispatchMap);
    }

    function dispatchProperty<T, TNode extends Node>(
      prop: ${union},
      node: TNode,
      dispatchMap: PartialDispatch<T>,
    ): T {
      const handler = dispatchMap[node._kind] ?? dispatchMap.Node;
      if (handler === undefined) {
        const err = new Error(\`Semantic property '\${prop}' not defined on '\${node._kind}'\`);
        Error.captureStackTrace(err, dispatchProperty)
        throw err
      }
      return handler(node as never)
    }
  `
}

function parseGrammarFromPath(path: string): AGGrammar {
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

export function parseGrammarFromString(text: string): AGGrammar {
  const parsed = grammar.match(text)
  if (parsed.message) {
    throw new Error(parsed.message)
  }

  const tree = semantics(parsed)
  ;(tree.check as () => void)() // Will throw in case of errors
  return tree.ast as AGGrammar
}

function generateCode(grammar: AGGrammar): string {
  // Will throw in case of errors
  validate(grammar)

  const output = [
    "/**",
    " * This file is AUTOMATICALLY GENERATED.",
    " * DO NOT edit this file manually.",
    " *",
    " * Instead, update the `ast.grammar` file, and re-run `generate-ast`.",
    " */",
    " /* eslint-disable */",
    "",
    `

    /**
     * Intended to augment by end users.
     *
     * See https://github.com/nvie/ast-generator/blob/main/README.md#assigning-semantics-meaning-to-nodes
     */
    export interface Semantics { }

    const DEBUG = process.env.NODE_ENV !== 'production';

    function assert(condition: boolean, errmsg: string): asserts condition {
      if (condition) return;
      throw new Error(errmsg);
    }

    function asNode<N extends Node>(node: Omit<N, keyof Semantics>): N {
      const self = Object.defineProperties(node, {
        range: { enumerable: false },
        ${grammar.externals
          .filter((ext) => ext.type === "property")
          .map(
            (ext) =>
              `${JSON.stringify(ext.name)}: { get: () => semanticPropertyFactories[${JSON.stringify(ext.name)}](self), enumerable: false },`
          )
          .join("\n")}
        ${grammar.externals
          .filter((ext) => ext.type === "method")
          .map(
            (ext) =>
              `${JSON.stringify(ext.name)}: { value: () => semanticMethods[${JSON.stringify(ext.name)}](self), enumerable: false, },`
          )
          .join("\n")}
      }) as N
      return self
    }

    `,
  ]

  for (const union of grammar.unions) {
    const [subNodes, subUnions] = partition(
      union.members,
      (ref) => getBareRefTarget(ref) === "Node"
    )
    const conditions = subNodes
      .map((ref) => `node._kind === ${JSON.stringify(getBareRef(ref))}`)
      .concat(subUnions.map((ref) => `is${getBareRef(ref)}(node)`))
    output.push(`
          export function is${union.name}(node: Node): node is ${union.name} {
            return (
              ${conditions.join(" || ")}
            )
          }
        `)
  }

  for (const union of grammar.unions) {
    output.push(`
      export type ${union.name} =
        ${union.members.map((member) => getBareRef(member)).join(" | ")};
    `)
  }

  output.push(`
    ${generateMethodHelpers(grammar)}
    ${generatePropertyHelpers(grammar)}

    export type Node = ${grammar.nodes.map((node) => node.name).join(" | ")}

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

    export function isNode(node: Node): node is Node {
      return (
        ${grammar.nodes
          .map((node) => `node._kind === ${JSON.stringify(node.name)}`)
          .join(" || ")}
      )
    }
  `)

  for (const node of grammar.nodes) {
    output.push(`
      export interface ${node.name} extends Semantics {
          _kind: ${JSON.stringify(node.name)}
          ${node.fields
            .map((field) => `${field.name}: ${getTypeScriptType(field.pattern)}`)
            .join("\n")}
          range: Range
      }
    `)
  }

  output.push("")
  for (const node of grammar.nodes) {
    const optionals = new Set(
      takeWhile(
        node.fields.slice().reverse(),
        (field) =>
          field.pattern.ref === "Optional" ||
          (field.pattern.ref === "List" && field.pattern.min === 0)
      ).map((field) => field.name)
    )

    const runtimeTypeChecks = node.fields.map((field) =>
      generateAssertParam(field.name, field.pattern, node.name)
    )
    runtimeTypeChecks.push(`assertRange(range, ${JSON.stringify(node.name)})`)

    output.push(`
      export function ${lowercaseFirst(node.name)}(${[
        ...node.fields.map((field) => {
          const key = field.name
          const type = getTypeScriptType(field.pattern)
          return optionals.has(field.name)
            ? `${key}: ${type} = ${field.pattern.ref === "Optional" ? "null" : "[]"}`
            : `${key}: ${type}`
        }),
        "range: Range = [0, 0]",
      ].join(", ")}): ${node.name} {
                ${
                  runtimeTypeChecks.length > 0
                    ? `DEBUG && (() => { ${runtimeTypeChecks.join("\n")} })()`
                    : ""
                }
                return asNode({
                    _kind: ${JSON.stringify(node.name)},
                    ${[...node.fields.map((field) => field.name), "range"].join(", ")}
                });
            }
            `)
  }

  // Generate a general purpose AST traversal/visit function
  output.push("interface Visitor<TContext> {")
  for (const node of grammar.nodes) {
    output.push(`  ${node.name}?(node: ${node.name}, context: TContext): void;`)
  }
  output.push("}")

  output.push("")
  output.push("interface PartialDispatch<T> extends Partial<ExhaustiveDispatch<T>> {")
  output.push("  // Catch-all")
  output.push("  Node?(node: Node): T;")

  // TODO Maybe also allow "Expr" rule as fallback for unions? If so, how to
  // handle it when a node type is part of multiple unions?',
  output.push("}")

  output.push("")
  output.push("interface ExhaustiveDispatch<T> {")
  output.push("  // Leafs")
  for (const node of grammar.nodes) {
    output.push(`  ${node.name}(node: ${node.name}): T;`)
  }
  output.push("}")

  output.push(
    `
      export function visit<TNode extends Node>(node: TNode, visitor: Visitor<undefined>): TNode;
      export function visit<TNode extends Node, TContext>(node: TNode, visitor: Visitor<TContext>, context: TContext): TNode;
      export function visit<TNode extends Node, TContext>(node: TNode, visitor: Visitor<TContext | undefined>, context?: TContext): TNode {
        switch (node._kind) {
        `
  )

  for (const node of grammar.nodes) {
    const fields = node.fields.filter(
      (field) => !isBuiltInType(getNodeRef(field.pattern))
    )

    output.push(`case ${JSON.stringify(node.name)}:`)
    output.push(`  visitor.${node.name}?.(node, context);`)
    for (const field of fields) {
      switch (field.pattern.ref) {
        case "Node":
        case "NodeUnion":
          output.push(`  visit(node.${field.name}, visitor, context);`)
          break

        case "List":
          output.push(
            `  node.${field.name}.forEach(${field.name[0]!} => visit(${field
              .name[0]!}, visitor, context));`
          )
          break

        case "Optional":
          output.push(
            `  // TODO: Implement visiting for _optional_ field node.${field.name}`
          )
          break
      }
    }
    output.push("  break;")
    output.push("")
  }

  output.push(
    `
        }

        return node;
      }
      `
  )

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

export async function generateAST(inpath: string, outpath: string): Promise<void> {
  const grammar = parseGrammarFromPath(inpath)
  const uglyCode = generateCode(grammar)

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
