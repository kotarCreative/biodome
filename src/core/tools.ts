import { BuildContext } from "./build-context.js"

export const toolHandlers: Record<string, (ctx: BuildContext) => void> = {
  gh: (ctx) => {
    ctx.addAptPackage("gh")
    ctx.addLanguageSnippet("RUN gh --version")
  },
  kubectl: (ctx) => {
    ctx.addLanguageSnippet(
      "RUN curl -fsSL https://dl.k8s.io/release/stable.txt > /tmp/kubectl-version && curl -fsSL https://dl.k8s.io/release/$(cat /tmp/kubectl-version)/bin/linux/amd64/kubectl -o /usr/local/bin/kubectl && chmod +x /usr/local/bin/kubectl"
    )
    ctx.addLanguageSnippet("RUN kubectl version --client")
  },
  terraform: (ctx) => {
    ctx.addLanguageSnippet(
      "RUN curl -fsSL https://releases.hashicorp.com/terraform/1.7.0/terraform_1.7.0_linux_amd64.zip -o /tmp/terraform.zip && unzip -o /tmp/terraform.zip -d /usr/local/bin/"
    )
    ctx.addLanguageSnippet("RUN terraform -version")
  },
  psql: (ctx) => {
    ctx.addAptPackage("postgresql-client")
    ctx.addLanguageSnippet("RUN psql --version")
  },
  "redis-cli": (ctx) => {
    ctx.addAptPackage("redis-tools")
    ctx.addLanguageSnippet("RUN redis-cli --version")
  },
  docker: (ctx) => {
    ctx.addAptPackage("docker.io")
    ctx.addLanguageSnippet("RUN docker --version")
  },
}
