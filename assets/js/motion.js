// Timings mirror css/main.css so everything on the page moves alike.
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)'

const REVEAL_DURATION = 460
const REVEAL_STAGGER = 26
const REVEAL_STAGGER_LIMIT = 340

const REORDER_DURATION = 440

function prefersReducedMotion () {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

function canAnimate (element) {
  return typeof element.animate === 'function' && !prefersReducedMotion()
}

// Opacity only: #playReorder owns the transform, and the two would fight during
// the first sort, which runs right after the last server is added.
export function reveal (element, index = 0) {
  if (!canAnimate(element)) {
    return
  }

  element.animate([
    { opacity: 0 },
    { opacity: 1 }
  ], {
    duration: REVEAL_DURATION,
    delay: Math.min(index * REVEAL_STAGGER, REVEAL_STAGGER_LIMIT),
    easing: EASE_OUT,
    // Holds it invisible during the delay instead of flashing first
    fill: 'backwards'
  })
}

// FLIP, first half. The caller reorders the DOM, then calls #playReorder.
export function captureRects (elements) {
  if (prefersReducedMotion()) {
    return
  }

  const rects = new Map()

  for (const element of Array.from(elements)) {
    rects.set(element, element.getBoundingClientRect())
  }

  return rects
}

// FLIP, second half: play each card back from where it was, so a rank change
// reads as the card moving rather than the list redrawing.
export function playReorder (rects) {
  if (!rects) {
    return
  }

  for (const [element, from] of rects) {
    // Zero size means the listing was still hidden when it was measured
    if (from.width === 0 || !canAnimate(element)) {
      continue
    }

    const to = element.getBoundingClientRect()
    const deltaX = from.left - to.left
    const deltaY = from.top - to.top

    if (deltaX === 0 && deltaY === 0) {
      continue
    }

    element.animate([
      { transform: `translate(${deltaX}px, ${deltaY}px)` },
      { transform: 'none' }
    ], {
      duration: REORDER_DURATION,
      easing: EASE_OUT
    })
  }
}
