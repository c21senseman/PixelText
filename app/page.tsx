import type { Metadata } from "next";
import PixelTextEditor from "./PixelTextEditor";

export const metadata: Metadata = {
  title: "PixelText — 무한 문자 캔버스",
  description: "경계 없는 2차원 공간 어디서든 쓰고 정리하는 문자 캔버스",
};

export default function Home() {
  return <PixelTextEditor />;
}
