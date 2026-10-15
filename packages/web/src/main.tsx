import { render } from "preact";
import { App } from "./app.tsx";
import "./styles.css";

const root = document.getElementById("app");
if (!root) throw new Error("#app element missing");
render(<App />, root);
