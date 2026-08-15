import { createRoot } from "react-dom/client";
import PixelTextEditor from "./PixelTextEditor";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("PixelText를 표시할 루트 요소를 찾지 못했습니다.");
}

createRoot(root).render(<PixelTextEditor />);
