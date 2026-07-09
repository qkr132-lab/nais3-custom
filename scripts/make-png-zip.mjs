// PNG+ZIP 합본 생성 (배포용): cover.png 뒤에 zip을 붙이고, ZIP 오프셋을 보정해
// 엄격한 압축 프로그램(윈도우 내장 포함)에서도 유효한 ZIP이 되게 한다.
// 사용: node make-png-zip.mjs <cover.png> <archive.zip> <out.png>
import { readFileSync, writeFileSync } from 'fs'

const [, , coverPath, zipPath, outPath] = process.argv
const cover = readFileSync(coverPath)
const zip = readFileSync(zipPath)
const delta = cover.length

// EOCD (PK\x05\x06