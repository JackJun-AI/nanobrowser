#!/bin/bash

# Build the background script
echo "Building background script..."
BUILD_ENTRY=background npx vite build

# Build the content script
echo "Building content script..."
BUILD_ENTRY=content npx vite build

echo "Build completed successfully!" 