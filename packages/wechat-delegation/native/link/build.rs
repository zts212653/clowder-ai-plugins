fn main() {
    println!("cargo:rerun-if-changed=src/keychain.c");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/keychain.c")
            // File-keychain ACLs are deliberate for this unprovisioned CLI.
            // No data-protection/access-group claim is made by this backend.
            .flag("-Wno-deprecated-declarations")
            .warnings_into_errors(true)
            .compile("clowder_keychain");
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
    }
}
