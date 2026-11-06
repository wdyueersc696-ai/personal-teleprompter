# UI adaptations in ReadReel

The home screen uses native JavaScript/CSS adaptations of the following registry
items, inspected through the shadcn MCP and `npx shadcn@latest view` on 2026-11-06.
They are integrated into this application, not distributed as a component library.

## React Bits — Silk

- Registry: https://reactbits.dev/r/Silk-JS-CSS.json
- Documentation: https://reactbits.dev/backgrounds/silk
- Copyright (c) 2026 David Haz
- License: [MIT + Commons Clause](./licenses/REACT-BITS.md)
- Adaptation: the fold field and relief shading in `js/home-effects.js` use a
  single low-resolution WebGL pass in a fixed peach palette. React hooks, bloom,
  click ripples and the general-purpose configuration API are omitted. Motion is
  capped at 20 fps / 450,000 pixels and stops outside the home screen. Reduced
  motion, manual pause, visibility changes and WebGL failure are handled locally.

## Magic UI — Magic Card / Interactive Hover Button

- Registries: https://magicui.design/r/magic-card.json and
  https://magicui.design/r/interactive-hover-button.json
- Documentation: https://magicui.design/docs/components/magic-card and
  https://magicui.design/docs/components/interactive-hover-button
- Copyright (c) Magic UI
- License: [MIT](./licenses/MAGIC-UI.md)
- Adaptation: native pointer coordinates drive the panels' radial highlights.
  The primary camera button uses the expanding fill and directional arrow idea.
  React, Motion, next-themes and Tailwind are not runtime dependencies.

## shadcn/ui

Button, Card and Slider documentation informed the control composition, sizing
and focus states. The project remains a static HTML/CSS/JavaScript application.
There is no shadcn installation or `components.json`, since the React/Tailwind
toolchain is not present. A native adaptation was chosen explicitly by the user.

## Existing assets

Manrope is distributed under `fonts/OFL-Manrope.txt`. ReadReel's cat SVGs and app
icons are project artwork and were retained in this update.
