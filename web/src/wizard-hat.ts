// A wizard hat icon for the wallet connect button, drawn for this page (the WizardConnect npm packages ship no logo
// asset). Decorative: the button text names WizardConnect, so the icon is hidden from assistive technology.
const SVG = 'http://www.w3.org/2000/svg';

/** Shapes in a 24 by 24 box: the cone with a bent tip, a band, the brim and one star. */
const SHAPES: readonly [string, Record<string, string>][] = [
  ['path', { class: 'hat-cone', d: 'M5.5 18.5 10.4 5.2c.5-1.4 1.6-2.2 3-2.2 1.9 0 3.4 1.1 4.6 2.6-1.5-.5-2.8-.4-3.6.4L18.5 18.5Z' }],
  ['path', { class: 'hat-band', d: 'M6.6 15.6h10.8l1 2.9H5.5Z' }],
  ['ellipse', { class: 'hat-brim', cx: '12', cy: '19.2', rx: '10', ry: '2.3' }],
  ['path', { class: 'hat-star', d: 'm12.2 8.3.6 1.3 1.4.2-1 1 .2 1.4-1.2-.7-1.3.7.3-1.4-1-1 1.4-.2Z' }],
];

/** The icon as an inline SVG element sized to the button text. */
export function wizardHat(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', class: 'wizard-hat', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(k, v);
  for (const [tag, attrs] of SHAPES) {
    const shape = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v);
    svg.append(shape);
  }
  return svg;
}
