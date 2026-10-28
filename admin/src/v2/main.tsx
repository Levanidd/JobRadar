import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { LanguageProvider } from "../i18n"
import App from "./App"
import { applyStoredTheme } from "./theme"
import "./v2.css"

applyStoredTheme()

const container = document.getElementById("root")
if (!container) throw new Error("#root not found")

createRoot(container).render(
  <StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </StrictMode>,
)
