/* eslint-disable @typescript-eslint/no-namespace */
import fs from 'node:fs'
import path from 'node:path'
import * as url from 'node:url'
import { globby, Options as GlobbyOptions } from 'globby'
import { debug } from './utils/debug'
import { getStdin } from './utils/stdin'
import { generateTmpName } from './utils/tmp'

export const markdownExtensions = ['md', 'mdown', 'markdown', 'markdn']

interface GenerateTmpFileInterfaceOptions {
  extension?: `.${string}`
}

export const generateTmpFileInterface = async ({
  extension,
}: GenerateTmpFileInterfaceOptions = {}): Promise<File.TmpFileInterface> => {
  const tmp = await generateTmpName(extension)

  let cleaned = false

  const cleanup = async () => {
    if (cleaned) return

    try {
      await fs.promises.unlink(tmp)
      debug('Cleaned up temporary file: %s', tmp)
      cleaned = true
    } catch (e) {
      debug('Failed to clean up temporary file: %o', e)
    }
  }

  return {
    path: tmp,
    cleanup,
    [Symbol.dispose]: () => void cleanup(),
    [Symbol.asyncDispose]: cleanup,
  }
}

export interface FileConvertOption {
  extension?: string
  page?: number
}

export enum FileType {
  File,
  StandardIO,
  Null,
}

export class File {
  buffer?: Buffer
  inputDir?: string
  type: FileType = FileType.File
  readonly path: string

  constructor(filepath: string) {
    this.path = filepath
  }

  get absolutePath(): string {
    return path.resolve(this.path)
  }

  get absoluteFileScheme(): string {
    return url.pathToFileURL(this.absolutePath).toString()
  }

  convert(output: string | false | undefined, opts: FileConvertOption): File {
    switch (output) {
      // Default conversion
      case undefined:
        return File.initialize(
          this.convertName(opts),
          (f) => (f.type = this.type)
        )

      // No output
      case false:
        return File.initialize(this.path, (f) => (f.type = FileType.Null))

      // Output to standard IO
      case '-':
        return File.initialize('-', (f) => (f.type = FileType.StandardIO))
    }

    // Relative path from output directory
    if (this.inputDir)
      return File.initialize(
        this.convertName({
          ...opts,
          basePath: path.join(output, this.relativePath(this.inputDir)),
        })
      )

    // Specified output filename
    return File.initialize(
      this.convertName({ ...opts, extension: undefined, basePath: output })
    )
  }

  async load() {
    this.buffer = this.buffer || (await fs.promises.readFile(this.path))
    return this.buffer
  }

  relativePath(from: string = process.cwd()) {
    return path.relative(from, this.absolutePath)
  }

  async save() {
    switch (this.type) {
      case FileType.File:
        await this.saveToFile()
        break
      case FileType.StandardIO:
        process.stdout.write(this.buffer!)
    }
  }

  async saveTmpFile({
    extension,
  }: GenerateTmpFileInterfaceOptions = {}): Promise<File.TmpFileInterface> {
    const tmp = await generateTmpFileInterface({ extension })

    debug('Saving temporary file: %s', tmp.path)
    await this.saveToFile(tmp.path)

    return tmp
  }

  private convertName(
    opts: FileConvertOption & { basePath?: string } = {}
  ): string {
    const { basePath, extension, page } = { basePath: this.path, ...opts }
    let ret = basePath

    // Convert extension
    if (extension !== undefined) {
      ret = path.join(
        path.dirname(basePath),
        `${path.basename(basePath, path.extname(basePath))}.${extension}`
      )
    }

    if (page !== undefined) {
      // Add page number
      const ext = path.extname(ret)
      const formatedPage = page.toString().padStart(3, '0')

      ret = path.join(
        path.dirname(ret),
        `${path.basename(ret, ext)}.${formatedPage}${ext}`
      )
    }

    return ret
  }

  private async saveToFile(savePath: string = this.path) {
    debug('Saving file: %s', savePath)

    const directory = path.dirname(path.resolve(savePath))

    if (path.dirname(directory) !== directory) {
      await fs.promises.mkdir(directory, { recursive: true })
    }

    await fs.promises.writeFile(savePath, this.buffer!)
    debug('Saved: %s', savePath)
  }

  private static stdinBuffer?: Buffer

  static async findPath(
    opts: GlobbyOptions,
    ...paths: string[]
  ): Promise<string[]> {
    const filepaths = new Set<string>()
    const globs: string[] = []
    const dirs: string[] = []

    // Collect passed files that refers to a real path at first
    for (const p of paths) {
      try {
        const s: fs.Stats = await fs.promises.stat(p)

        if (s.isFile()) {
          filepaths.add(path.resolve(p))
          continue
        } else if (s.isDirectory()) {
          dirs.push(path.resolve(p))
          continue
        }
      } catch {
        // No ops
      }

      // Convert file path to glob pattern (micromatch must use "/" as path separator)
      globs.push(p.split(path.sep).join('/'))
    }

    // Find remaining path through globby
    const gOpts = { absolute: true, ignore: ['**/node_modules'], ...opts }
    ;(await globby(globs, gOpts)).forEach((p) => filepaths.add(p))

    for (const cwd of dirs) {
      ;(await globby('.', { cwd, ...gOpts })).forEach((p) => filepaths.add(p))
    }

    return [...filepaths.values()].map((p) => path.normalize(p))
  }

  static async find(...paths: string[]): Promise<File[]> {
    return (
      await this.findPath(
        {
          expandDirectories: {
            extensions: [],
            files: markdownExtensions.map((ext) => `*.${ext}`),
          },
        },
        ...paths
      )
    ).map((p) => new File(p))
  }

  static async findDir(directory: string): Promise<File[]> {
    const found = await this.find(directory)
    found.forEach((p) => (p.inputDir = path.resolve(directory)))

    return found
  }

  static async stdin(): Promise<File | undefined> {
    this.stdinBuffer = this.stdinBuffer || (await getStdin())
    if (this.stdinBuffer.length === 0) return undefined

    return this.initialize('-', (f) => {
      f.buffer = this.stdinBuffer
      f.type = FileType.StandardIO
    })
  }

  private static initialize(filepath: string, tap?: (instance: File) => void) {
    const instance = new this(filepath)
    tap?.(instance)
    return instance
  }
}

export namespace File {
  export interface TmpFileInterface extends AsyncDisposable, Disposable {
    path: string
    cleanup: () => Promise<void>
  }
}
