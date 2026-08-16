// 类型垫片：app 生产构建剥离了 .d.ts，这里用 any 占位，仅用于编译通过。
declare module '@deepseek-ai/cordis' {
  export type Context = any
}
declare module '@deepseek-ai/dsh-tools' {
  export function defineTool(def: any): any
}
declare module '@deepseek-ai/schemastery' {
  const z: any
  export default z
}
declare module '@deepseek-ai/dsh-settings' {
  export function installSettingsSection(ctx: any, ns: any, schema: any, entry: any, hooks: any): void
}
declare module '@deepseek-ai/dsh-llm' {
  export function createUserMessage(input: any): any
}
