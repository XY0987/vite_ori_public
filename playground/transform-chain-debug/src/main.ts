import './style.css'
import classes from './theme.module.css'
import { message } from './message'
import logoUrl from './logo.svg?url'
import rawText from './note.txt?raw'

const app = document.querySelector<HTMLDivElement>('#app')!

app.className = classes.card
app.innerHTML = `
  <img class="${classes.logo}" src="${logoUrl}" alt="Vite logo" />
  <h1>${message}</h1>
  <pre>${rawText}</pre>
`
