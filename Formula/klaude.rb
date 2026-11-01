# Homebrew formula for Klaude. Updated automatically by .github/workflows/release.yml.
#
#   brew tap ihumaunkabir/klaude https://github.com/ihumaunkabir/klaude
#   brew install klaude
class Klaude < Formula
  desc "Coding agent for the terminal powered by local LLMs via Ollama"
  homepage "https://github.com/ihumaunkabir/klaude"
  url "https://registry.npmjs.org/klaude-cli/-/klaude-cli-0.1.1.tgz"
  sha256 "1c5f9081518c285de07078bbdf03701a6a4b3621b9d5cb746e4ac36cbffd5016"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  def caveats
    <<~EOS
      Klaude needs a running Ollama server with a model pulled:
        brew install ollama && ollama serve
        ollama pull qwen3-coder
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/klaude --version")
  end
end
