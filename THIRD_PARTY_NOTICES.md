# Third-party notices

Pocket Voxel 3D builds on other people's work. The notices below cover the
parts that carry a licence.

## gen1recomp

The gameplay code is a port of the gen1recomp engine, and the converter
downloads its symbol tables and data. Both use the MIT-licensed version at
commit `943ba5dcbfa62cf831e881684857ffd4867fe774` (August 2026), which
`cooker/cooker.py` pins.

Pokémon Gold (Gen 2) ports the same project's Gen 2 support from its last
MIT-licensed commit, `bdfac727aaccfea696be49a23c5f501451be50d5` (18 September
2026), under the same licence; nothing after the project's relicensing is
used.

https://github.com/bryanthaboi/gen1recomp

```
Copyright 2026 BOIS CLUB GAMES, LLC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Kanto Gear

The bottom-screen companion is modelled on the Kanto Gear mod for gen1recomp.

https://github.com/AverageConsumer/kanto-gear

```
MIT License

Copyright (c) 2026 AverageConsumer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## PotatoVoxel

The shape table is used with its author's permission.

https://github.com/ShaneMcGovernIE/potato_voxel

## Gen2Recomped-DramaticShapes

Pokémon Gold's voxel shape rules (the Gen 2 collision classes, the Johto
building templates and the Gen 2 tile classifier) are ported from this Gen 2
edition of the Dramatic Shape voxel mod, commit `726782f`, and the Gold cook
reads its height profile.

https://github.com/UNDERdecoded/Gen2Recomped-DramaticShapes

```
MIT License

Copyright (c) 2026 DramaticShape

Modified by UNDERdecodedHD, 2026, to add Generation II (Gold/Silver/Crystal)
support.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## pokered-gbc

If you choose colour, the converter downloads pokered-gbc's palettes on your
machine. None of it is included in this repository.

https://github.com/Stewmath/pokered-gbc
