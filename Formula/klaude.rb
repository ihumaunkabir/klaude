# Homebrew formula for Klaude. Updated automatically by .github/workflows/release.yml.
#
#   brew tap ihumaunkabir/klaude https://github.com/ihumaunkabir/klaude
#   brew install klaude
class Klaude < Formula
  desc "Coding agent for the terminal powered by local LLMs via Ollama"
  homepage "https://github.com/ihumaunkabir/klaude"
  url "https://registry.npmjs.org/klaude-cli/-/klaude-cli-0.2.0.tgz"
  sha256 "33c53ae4f4ccd2fe433a430b03ebd93935ac84a5a9117ceed3c2a7c9d434faac"
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
