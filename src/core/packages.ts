import { PackageOptions } from "./feature.js"

export function formatPackage(name: string, options: PackageOptions, sep = "@"): string {
  return options.version ? `${name}${sep}${options.version}` : name
}
