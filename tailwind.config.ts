import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        ink: "#0b1115",
        graphite: "#1f2a30",
        mist: "#f7f9f7",
        line: "#e5ebe7",
        money: "#00c805",
        loss: "#ff4d4f",
        gold: "#c8962e"
      },
      boxShadow: {
        soft: "0 18px 50px rgba(15, 23, 42, 0.08)",
        lift: "0 20px 60px rgba(10, 17, 21, 0.12)"
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"]
      }
    }
  },
  plugins: []
};

export default config;
