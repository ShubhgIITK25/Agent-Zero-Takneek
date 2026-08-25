declare module '@xterm/xterm' {
  export interface ITerminalOptions {
    convertEol?: boolean;
    fontFamily?: string;
    fontSize?: number;
    theme?: { background?: string; foreground?: string; cursor?: string };
    cursorBlink?: boolean;
  }
  export class Terminal {
    constructor(options?: ITerminalOptions);
    cols: number;
    rows: number;
    loadAddon(addon: unknown): void;
    open(el: HTMLElement): void;
    write(data: string): void;
    onData(cb: (data: string) => void): { dispose(): void };
    dispose(): void;
  }
}
declare module '@xterm/addon-fit' {
  export class FitAddon {
    fit(): void;
  }
}
declare module '@xterm/xterm/css/xterm.css';
