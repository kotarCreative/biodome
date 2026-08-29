#!/usr/bin/env node
import { createProgram } from "./program.js";
import { initializeCliEnvironment } from "./load-env.js";

initializeCliEnvironment();
createProgram().parse();
