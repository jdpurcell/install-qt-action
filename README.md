# install-qt-action
Fork of [jurplel](https://github.com/jurplel)'s wonderful `install-qt-action`. Getting started:

```yml
- name: Install Qt
  uses: jdpurcell/install-qt-action@v5
  with:
    # your options here
```

## Additional features
Most of the features originally implemented here (e.g. support for ARM64 hosts) have been incorporated into the official version. The only remaining differences are:
* Option to use alternate backend [naqt](https://github.com/jdpurcell/naqt) which runs via dotnet instead of Python.
* Some other options such as `mirror` and `nohash`.

## Options
This fork retains all options of the original, so you can largely refer to the [official documentation](https://github.com/jurplel/install-qt-action#options). The only noteworthy additions are:

### `use-naqt`
Set to `true` to use use [naqt](https://github.com/jdpurcell/naqt) as the installer backend. This only applies to the main Qt binaries since `naqt` doesn't implement commands to support the `tools`, `source`, `documentation`, or `examples` options. Assuming you aren't using any of those, you can also set `setup-python` to `false` since `naqt` doesn't need it.

Default: `false`

### `autodesktop`
Set to `true` to enable the `--autodesktop` option when installing Qt. For cross-compilation installations (e.g. WASM, Android, iOS) this will automatically install the corresponding desktop version of Qt. If you don't want the desktop version, or plan to install it separately in a different step, you can disable this.

Default: `true`

### `extensions`
Space delimited list of Qt extensions to install. With `aqtinstall` these will be appended to the list of requested modules since its command line arguments don't differentiate between modules and extensions. With `naqt` these will be passed in a separate argument. `naqt` also allows extensions to be specified as modules for compatibility with `aqtinstall`, but specifying them explicitly allows it to work with future extensions even if they aren't in `naqt`'s known extension list.

Example values: `qtwebengine`, `qtpdf`

### `mirror`
Base address of the mirror to use for downloading Qt.

Example: `https://qt.mirror.constant.com`

Default: Use the official Qt mirror.

### `nohash`
Set to `true` to disable hash checking when downloading Qt. Use with caution, e.g. only for testing or as a last resort if Qt's official mirror (which hosts the hashes) is down.

Default: `false`
