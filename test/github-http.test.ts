import { expect, it, vi } from 'vitest'
import { GithubHttp } from '../src/github/http.js'
it('pins the origin, rejects redirects and arbitrary routes, and never echoes error bodies',async()=>{
  const fetcher=vi.fn(async(_url:string,_init:RequestInit)=>new Response('SECRET response',{status:401})),http=new GithubHttp(fetcher)
  for(const path of ['https://evil.test/','/user','/repos/a/../secrets','/repos/a/b/contents/token','/repos/a/b/issues?url=https://evil.test'])await expect(http.request('SECRET','GET',path,undefined,AbortSignal.timeout(1000))).rejects.toThrow('invalid GitHub route')
  expect(fetcher).not.toHaveBeenCalled()
  await expect(http.request('SECRET','GET','/repos/a/b',undefined,AbortSignal.timeout(1000))).rejects.toThrow('HTTP 401')
  expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.github.com/repos/a/b')
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({redirect:'error',headers:{Authorization:'Bearer SECRET'}})
})
it('does not retry uncertain or rate-limited writes',async()=>{
  const fetcher=vi.fn(async()=>new Response('',{status:503})),http=new GithubHttp(fetcher)
  await expect(http.request('token','POST','/repos/a/b/issues',{title:'x'},AbortSignal.timeout(1000))).rejects.toMatchObject({outcome:'unknown'})
  expect(fetcher).toHaveBeenCalledTimes(1)
  fetcher.mockResolvedValue(new Response('',{status:429,headers:{'retry-after':'30'}}))
  await expect(http.request('token','POST','/repos/a/b/issues',{},AbortSignal.timeout(1000))).rejects.toMatchObject({outcome:'failed',retryAfter:30})
  await expect(http.request('token','POST','/repos/a/b/issues',{},AbortSignal.timeout(1000))).rejects.toThrow('rate limited')
  expect(fetcher).toHaveBeenCalledTimes(2)
})
