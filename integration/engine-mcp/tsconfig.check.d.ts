// 仅用于独立类型检查（tsconfig.check.json）：真实项目里 dotenv 有正式类型。
declare module 'dotenv' {
  export function config(opts?: { path?: string }): void;
}
