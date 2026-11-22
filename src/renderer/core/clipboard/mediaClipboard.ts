import type { LGraphCanvas, LGraphNode } from '@/lib/litegraph/src/litegraph'
import { createNode } from '@/utils/createNode'
import {
  getFilesFromItems,
  hasAudioType,
  hasImageType,
  hasVideoType
} from '@/utils/eventUtils'

function pasteItemsOnNode(
  files: File[],
  node: LGraphNode | null,
  contentType: 'image' | 'audio' | 'video'
): void {
  if (!node) return

  const matchesContentType =
    contentType === 'image'
      ? hasImageType
      : contentType === 'audio'
        ? hasAudioType
        : hasVideoType
  const filteredFiles = files.filter(matchesContentType)
  const blob = filteredFiles.at(0)
  if (!blob) return

  node.pasteFile?.(blob)
  node.pasteFiles?.(filteredFiles)
}

export async function pasteImageNode(
  canvas: LGraphCanvas,
  items: DataTransferItemList,
  imageNode: LGraphNode | null = null,
  files = getFilesFromItems(items)
): Promise<LGraphNode | null> {
  const node = imageNode ?? (await createNode(canvas, 'LoadImage'))
  pasteItemsOnNode(files, node, 'image')
  return node
}

export async function pasteImageNodes(
  canvas: LGraphCanvas,
  fileList: File[]
): Promise<LGraphNode[]> {
  const nodes: LGraphNode[] = []
  for (const file of fileList) {
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const node = await pasteImageNode(canvas, transfer.items)
    if (node) nodes.push(node)
  }
  return nodes
}

export async function pasteAudioNode(
  canvas: LGraphCanvas,
  items: DataTransferItemList,
  audioNode: LGraphNode | null = null,
  files = getFilesFromItems(items)
): Promise<LGraphNode | null> {
  const node = audioNode ?? (await createNode(canvas, 'LoadAudio'))
  pasteItemsOnNode(files, node, 'audio')
  return node
}

export async function pasteAudioNodes(
  canvas: LGraphCanvas,
  fileList: File[]
): Promise<LGraphNode[]> {
  const nodes: LGraphNode[] = []
  for (const file of fileList) {
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const node = await pasteAudioNode(canvas, transfer.items)
    if (node) nodes.push(node)
  }
  return nodes
}

export async function pasteVideoNode(
  canvas: LGraphCanvas,
  items: DataTransferItemList,
  videoNode: LGraphNode | null = null,
  files = getFilesFromItems(items)
): Promise<LGraphNode | null> {
  const node = videoNode ?? (await createNode(canvas, 'LoadVideo'))
  pasteItemsOnNode(files, node, 'video')
  return node
}

export async function pasteVideoNodes(
  canvas: LGraphCanvas,
  fileList: File[]
): Promise<LGraphNode[]> {
  const nodes: LGraphNode[] = []
  for (const file of fileList) {
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const node = await pasteVideoNode(canvas, transfer.items)
    if (node) nodes.push(node)
  }
  return nodes
}
