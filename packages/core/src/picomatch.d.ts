declare module 'picomatch' {
  interface PicomatchOptions {
    dot?: boolean;
  }
  type Matcher = (test: string) => boolean;
  function picomatch(globs: string | string[], options?: PicomatchOptions): Matcher;
  export default picomatch;
}
