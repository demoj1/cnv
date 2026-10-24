/** `import text from './file?raw'` — содержимое файла строкой (возможность Vite). */
declare module '*?raw' {
  const text: string
  export default text
}
