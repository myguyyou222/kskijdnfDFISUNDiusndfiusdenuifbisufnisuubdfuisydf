# To learn more about how to use Nix to configure your environment
# see: https://developers.google.com/idx/guides/customize-idx-env
{pkgs}: {
  # Which nixpkgs channel to use.
  channel = "stable-24.11"; # or "unstable"
  # Use https://search.nixos.org/packages to find packages
  packages = [
    pkgs.nodejs_22
    pkgs.yarn
    pkgs.nodePackages.pnpm
    pkgs.bun
    # Tailscale CLI + daemon — needed by the OpenCode proxy to discover
    # the runner over the Tailscale API, and by the runner to join the tailnet.
    pkgs.tailscale
  ];
  # Sets environment variables in the workspace
  env = {};
  idx = {
    # Search for the extensions you want on https://open-vsx.org/ use "publisher.id"
    extensions = [
      # "vscodevim.vim"
      "google.gemini-cli-vscode-ide-companion"
    ];
    workspace = {
      # Runs when a workspace is first created with this `dev.nix` file
      onCreate = {
        npm-install = "npm ci --no-audit --prefer-offline --no-progress --timing";
        # Open editors for the following files by default, if they exist
        default.openFiles = [
          "app/page.tsx" "app/page.js"
          "src/app/page.tsx" "src/app/page.js"
        ];
      };
      # To run something each time the workspace is (re)started, use the `onStart` hook
      # onStart = {
      #   "server": "npm run start",
      # };
    };
    # Enable previews and customize configuration
    previews = {
      enable = true;
      previews = {
        web = {
          # port = 3000;
          # open = true;
        };
      };
    };
  };
}