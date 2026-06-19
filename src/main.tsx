import React from "react";
import ReactDOM from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "highlight.js/styles/github.css";
import "./styles.css";
import { App } from "./ui/App";
import { InputDialogHost } from "./ui/components/InputDialogHost";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    <InputDialogHost />
  </React.StrictMode>
);
