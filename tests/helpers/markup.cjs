'use strict';

// Server-rendered markup for renderer tests: render a component to static
// HTML, and read that HTML back as the text a person would see.

const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

// Tags become spaces, runs of whitespace collapse to one, and the ends are trimmed.
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// As text, but also decodes the apostrophes and ampersands React escapes.
const decodedText = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

module.exports = { render, text, decodedText };
