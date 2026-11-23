// Vite's `?raw` import: the file's text as a string (`src/cron-list.ts` imports the page this way).
declare module '*.html?raw' {
    const text: string
    export default text
}

// The same for the design system's stylesheet (`src/owner-page.ts` imports `benny-design.css`).
declare module '*.css?raw' {
    const text: string
    export default text
}
