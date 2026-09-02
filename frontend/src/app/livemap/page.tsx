"use client";

import dynamic from "next/dynamic";

const LiveMap = dynamic(() => import("../LiveMap"), {
  ssr: false,
});

export default function LiveMapPage() {
  return (
    <main
      style={{
        width: "100%",
        height: "100vh",
      }}
    >
      <LiveMap />
    </main>
  );
}