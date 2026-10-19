import { renderTile, renderTiles } from "./dock.js";
import { tileKey, moveTile } from "./tiles.js";

// Phones use the two-row grids; tablets have room for a third row.
export const GRIDS = Object.freeze({
  4: { columns: 2, rows: 2, iconSize: 160, scale: .44 },
  6: { columns: 3, rows: 2, iconSize: 138, scale: .38 },
  8: { columns: 4, rows: 2, iconSize: 116, scale: .32 },
  12: { columns: 4, rows: 3, iconSize: 112, scale: .27 },
  15: { columns: 5, rows: 3, iconSize: 100, scale: .24 },
  18: { columns: 6, rows: 3, iconSize: 92, scale: .21 },
  21: { columns: 7, rows: 3, iconSize: 84, scale: .19 },
  24: { columns: 6, rows: 4, iconSize: 80, scale: .17 },
  28: { columns: 7, rows: 4, iconSize: 72, scale: .155 },
  32: { columns: 8, rows: 4, iconSize: 66, scale: .145 },
});

/** Swap two whole pages. Only full pages move, so no page gains a gap. */
export function movePage(tiles, page, delta, capacity) {
  const target = page + delta;
  const pages = Math.ceil(tiles.length / capacity);
  if (target < 0 || target >= pages || page < 0 || page >= pages) return null;
  const full = (index) => (index + 1) * capacity <= tiles.length;
  if (!full(page) || !full(target)) return null;
  const chunks = Array.from({ length: pages }, (_, index) => tiles.slice(index * capacity, (index + 1) * capacity));
  [chunks[page], chunks[target]] = [chunks[target], chunks[page]];
  return chunks.flat();
}

export function normalizeLayout(value = {}) {
  // Upgrade earlier row/column preferences to one of the supported grids.
  const oldCapacity = Number(value?.columns) * Number(value?.rows);
  const perPage = Object.hasOwn(GRIDS, Number(value?.perPage)) ? Number(value.perPage)
    : value?.perPage === undefined && [4, 6, 8].includes(oldCapacity) ? oldCapacity : 4;
  const grid = GRIDS[perPage];
  return {
    perPage,
    columns: grid.columns,
    rows: grid.rows,
    iconSize: grid.iconSize,
    immersive: value?.immersive !== false,
    showLabels: value?.showLabels === true,
    background: ["aurora", "dusk", "ember", "midnight"].includes(value?.background) ? value.background : "aurora",
    theme: ["glass", "frost", "smoke"].includes(value?.theme) ? value.theme : "glass",
  };
}

export function pageCount(tiles, layout) {
  return Math.max(1, Math.ceil(tiles.length / (layout.columns * layout.rows)));
}

export function renderPages(state, layout, editing = false) {
  if (!state.tiles.length) return renderTiles(state);
  const capacity = layout.columns * layout.rows;
  return Array.from({ length: pageCount(state.tiles, layout) }, (_, page) =>
    `<div class="dock-page" role="group" aria-label="Page ${page + 1}">${state.tiles.slice(page * capacity, (page + 1) * capacity).map((tile) => renderTile(tile, { editing, launcher: true })).join("")}</div>`
  ).join("");
}

export function moveToTile(tiles, key, targetKey) {
  const from = tiles.findIndex((tile) => tileKey(tile) === key);
  const to = tiles.findIndex((tile) => tileKey(tile) === targetKey);
  return from < 0 || to < 0 ? tiles : moveTile(tiles, key, to - from);
}
